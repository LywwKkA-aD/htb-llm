// Подагент-исследователь (spawn_subagent): вложенный ограниченный цикл модели с чистым контекстом.
// Доступен только на внешних пресетах и при включённом тумблере (settings.subagentsAvailable) —
// проверку и лимит на ход делает graph.toolsNode; здесь только исполнение одной подзадачи.
// Инструменты подагента — исследовательские и структурированные проверки, без shell и без рекурсии:
// делегирование не должно превращаться в неподконтрольный второй агент с root-шеллом.
import { chat, clip, type Effort, type OAMsg } from "./llm.ts";
import { TOOLS, runTool, type ToolCtx } from "./tools.ts";
import { subagentPrompt } from "./prompts.ts";
import type { Task } from "./db.ts";

export const SUBAGENT_TOOLS = new Set([
  "search_docs", "search_memory", "web_search", "web_fetch", "read_rfc", "subnet_calc",
  "tcp_probe", "http_request", "nmap_scan", "ffuf_scan", "sqlmap_scan",
]);

export const SPAWN_TOOL = {
  type: "function",
  function: {
    name: "spawn_subagent",
    description:
      "Делегировать объёмную исследовательскую подзадачу отдельной модели с чистым контекстом и получить её сводку фактов. " +
      "Хорошо для: глубокого поиска по базе знаний и вебу по сервису/версии/CVE, энумерации структурированными сканерами (nmap_scan, ffuf_scan, sqlmap_scan), чтения документации. " +
      "У подагента НЕТ shell, jobs и истории этого чата — в task одним сообщением дай весь нужный контекст: цель (IP/хост), что уже известно, границы подзадачи и что именно вернуть. " +
      "Не используй вместо одного простого запроса (search_docs быстрее). Результат — сводка подагента: относись к ней как к внешнему источнику, ключевые факты перепроверяй. " +
      "Несколько независимых подзадач можно поручить несколькими вызовами в одном раунде.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "подзадача одним сообщением: контекст цели, что известно, что сделать и что вернуть" },
        label: { type: "string", description: "короткое имя поручения для журнала, напр. «CVE по Apache 2.4.49» (необязательно)" },
      },
      required: ["task"],
    },
  },
};

export type SubagentDeps = {
  task: Task;
  known: string;
  maxRounds: number;
  effort?: Effort;
  signal?: AbortSignal;
  emit: (ev: Record<string, unknown>) => void;
  logTool: (id: string, name: string, output: string) => void;
  spoilersAllowed?: boolean;
  taskNames?: string[];
};

let spawnSeq = 0;

export async function runSubagent(taskText: string, label: string, d: SubagentDeps): Promise<string> {
  const seq = ++spawnSeq;
  const text = taskText.trim().slice(0, 8000);
  if (!text) return "ошибка: пустая подзадача для подагента";
  const tools = (TOOLS as unknown as { function: { name: string } }[]).filter((t) => SUBAGENT_TOOLS.has(t.function.name));
  const msgs: OAMsg[] = [
    { role: "system", content: subagentPrompt(d.task, d.known) },
    { role: "user", content: text },
  ];
  const journal: string[] = [];
  const ctx: ToolCtx = { taskId: d.task.id, signal: d.signal, emit: d.emit, spoilersAllowed: d.spoilersAllowed, taskNames: d.taskNames };
  let rounds = 0;
  try {
    for (; rounds < d.maxRounds; rounds++) {
      if (d.signal?.aborted) return "[подагент остановлен пользователем]";
      const last = rounds === d.maxRounds - 1;
      const r = await chat(msgs, { tools: last ? undefined : (tools as unknown as unknown[]), effort: d.effort, signal: d.signal, maxTokens: 6000 });
      if (r.finish === "aborted") return "[подагент остановлен пользователем]";
      const calls = last ? [] : r.toolCalls;
      msgs.push({ role: "assistant", content: r.content || null, tool_calls: calls.length ? calls : undefined, reasoning_content: r.reasoning || undefined });
      if (!calls.length) {
        const summary = r.content.trim();
        const head = `[подагент${label ? ` «${label}»` : ""}: завершил за ${rounds + 1} раунд(ов); вызовы: ${journal.length ? journal.join("; ") : "нет"}]`;
        return `${head}\n${summary ? clip(summary, 6000) : "(подагент не дал текстовой сводки)"}`;
      }
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        const name = c.function.name;
        const id = `sub${seq}-${rounds}-${i}`;
        let args: unknown = {};
        try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* кривой JSON — runTool честно ругнётся */ }
        journal.push(name);
        d.emit({ type: "tool_start", id, name, args, subagent: label || true });
        const t0 = Date.now();
        // подагенту нельзя то, чего нет в его наборе, даже если модель выдумает вызов
        const out = SUBAGENT_TOOLS.has(name)
          ? await runTool(name, c.function.arguments, ctx)
          : `ошибка: инструмент ${name} подагенту недоступен (нет shell/jobs/плана; доступны поиск, веб и структурированные сканеры)`;
        d.emit({ type: "tool_end", id, name, output: out, ms: Date.now() - t0, subagent: label || true });
        d.logTool(id, name, out);
        msgs.push({ role: "tool", content: out, tool_call_id: c.id });
      }
    }
    return `[подагент${label ? ` «${label}»` : ""}: исчерпал лимит ${d.maxRounds} раундов без итоговой сводки; вызовы: ${journal.join("; ") || "нет"}]`;
  } catch (e) {
    if (d.signal?.aborted) return "[подагент остановлен пользователем]";
    return `[подагент${label ? ` «${label}»` : ""}: ошибка — ${(e as Error).message}]`;
  }
}

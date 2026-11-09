import { execSync } from "node:child_process";
import path from "node:path";

// убрать Kali-контейнеры, созданные тестами (метка whitehat.data = tests/.data)
export default function teardown() {
  const data = process.env.E2E_DATA ?? path.resolve(import.meta.dirname, ".data");
  try {
    const ids = execSync(`docker ps -aq --filter "label=whitehat.data=${data}"`).toString().trim();
    if (ids) execSync(`docker rm -f ${ids.split("\n").join(" ")}`, { stdio: "ignore" });
  } catch { /* docker недоступен — нечего чистить */ }
}

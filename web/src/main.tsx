import { createRoot } from "react-dom/client";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";
import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/700.css";
import "katex/dist/katex.min.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Root } from "./App";

createRoot(document.getElementById("root")!).render(<Root />);

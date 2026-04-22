import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// NOTE: React.StrictMode is intentionally off in dev — it double-mounts
// components, which causes node-pty + xterm to spawn/kill/spawn in rapid
// succession and was hypothesized to break focus landing.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

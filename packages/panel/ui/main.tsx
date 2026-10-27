import { render } from "preact";
import { App } from "./app.tsx";
import "gridstack/dist/gridstack.min.css";
import "./style.css";

render(<App />, document.getElementById("app")!);

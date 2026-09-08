import { h, render } from "preact";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/global.css";

const container = document.getElementById("app");

render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
  container!,
);

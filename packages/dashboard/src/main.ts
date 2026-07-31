import { Chart, registerables } from "chart.js";

import { initializeAdminToken } from "./api";
import { disposeCostExplorer, renderCostExplorer } from "./cost-explorer";
import { disposeOverview, renderOverview } from "./overview";
import { disposePrompts, renderPrompts } from "./prompts";
import { disposeQualityDrift, renderQualityDrift } from "./quality-drift";
import "./style.css";

Chart.register(...registerables);

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
	throw new Error("Dashboard root is missing.");
}
const root = app;

function currentRoute(): "overview" | "cost" | "prompts" | "quality" {
	const hash = window.location.hash.replace(/^#/, "");
	return hash === "cost" || hash === "prompts" || hash === "quality"
		? hash
		: "overview";
}

let disposeActiveScreen: () => void = () => undefined;

function renderRoute(moveFocus = false): void {
	disposeActiveScreen();
	const route = currentRoute();
	if (route === "overview") {
		renderOverview(root);
		disposeActiveScreen = disposeOverview;
	} else if (route === "cost") {
		renderCostExplorer(root);
		disposeActiveScreen = disposeCostExplorer;
	} else if (route === "prompts") {
		renderPrompts(root);
		disposeActiveScreen = disposePrompts;
	} else {
		renderQualityDrift(root);
		disposeActiveScreen = disposeQualityDrift;
	}
	if (moveFocus) root.querySelector<HTMLElement>("#dashboard-content")?.focus();
}

// Render a useful route before opening the in-memory admin-token prompt.
app.innerHTML = "";
renderRoute();
initializeAdminToken();
window.addEventListener("hashchange", () => renderRoute(true));

import { Chart, registerables } from "chart.js";

import { initializeAdminToken } from "./api";
import { disposeCostExplorer, renderCostExplorer } from "./cost-explorer";
import { disposeOverview, renderOverview } from "./overview";
import { disposePrompts, renderPrompts } from "./prompts";
import "./style.css";

Chart.register(...registerables);

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
	throw new Error("Dashboard root is missing.");
}
const root = app;

function renderPlaceholder(_section: "quality"): void {
	const title = "Quality drift";
	root.innerHTML = `<div class="app-shell"><header class="app-header"><a class="brand" href="#overview" aria-label="PromptGate dashboard home"><span class="brand__mark" aria-hidden="true">P</span><span>PromptGate</span></a><nav aria-label="Dashboard sections"><a class="nav-link" href="#overview">Overview</a><a class="nav-link" href="#cost">Cost</a><a class="nav-link" href="#prompts">Prompts</a><a class="nav-link nav-link--active" href="#quality" aria-current="page">Quality</a></nav></header><main id="dashboard-content" tabindex="-1"><section class="error-state" aria-labelledby="coming-title"><h1 id="coming-title">${title} is coming next</h1><p>This dashboard section is not built yet. Overview, Cost Explorer, and Prompts are available now.</p></section></main></div>`;
}

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
		renderPlaceholder(route);
		disposeActiveScreen = () => undefined;
	}
	if (moveFocus) root.querySelector<HTMLElement>("#dashboard-content")?.focus();
}

// Render a useful route before opening the in-memory admin-token prompt.
app.innerHTML = "";
renderRoute();
initializeAdminToken();
window.addEventListener("hashchange", () => renderRoute(true));

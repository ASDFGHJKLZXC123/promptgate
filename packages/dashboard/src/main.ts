import { Chart, registerables } from "chart.js";

import { initializeAdminToken } from "./api";
import { renderOverview } from "./overview";
import "./style.css";

Chart.register(...registerables);

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
	throw new Error("Dashboard root is missing.");
}

// Render the useful shell before opening the in-memory admin-token prompt.
app.innerHTML = "";
renderOverview(app);
initializeAdminToken();

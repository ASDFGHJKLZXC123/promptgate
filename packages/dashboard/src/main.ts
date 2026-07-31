import { Chart, registerables } from "chart.js";

import { initializeAdminToken } from "./api";
import "./style.css";

Chart.register(...registerables);

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
	throw new Error("Dashboard root is missing.");
}

app.innerHTML = `
	<header class="site-header">
		<div class="site-header__content">
			<p class="eyebrow">PromptGate</p>
			<h1>Dashboard</h1>
		</div>
	</header>
	<main id="dashboard-content" tabindex="-1">
		<section class="dashboard-shell" aria-labelledby="scaffold-status">
			<h2 id="scaffold-status">Dashboard scaffold ready</h2>
			<p>
				This local dashboard will display live PromptGate administration data once its
				screens are connected.
			</p>
		</section>
	</main>
`;

initializeAdminToken();

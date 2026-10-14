import { Menu } from "./menu.js";

window.addEventListener("DOMContentLoaded", () => {
    const root = document.getElementById("app");
    new Menu(root);
});

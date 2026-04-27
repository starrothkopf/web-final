
const inputText = document.getElementById("input");
const outputText = document.getElementById("output");

inputText.addEventListener("input", autoResize);

document.getElementById("shakeBtn").addEventListener("click", shakePoem);
document.getElementById("pickBtn").addEventListener("click", pickPoem);

function autoResize() {
    inputText.style.height = "auto";
    inputText.style.height = inputText.scrollHeight + "px";
}

function shuffle(words) {
    const arr = [...words]; // Fisher-Yates
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function makeLines(words) {
    let i = 0;
    const lines = [];

    while (i < words.length) {
        const len = Math.floor(Math.random() * 6) + 3;
        lines.push(words.slice(i, i + len).join(" "));
        i += len;
    }

    return lines;
}

function pickFew(words, n = 3) {
    return shuffle(words).slice(0, n);
}

function shakePoem(e) {
    e.preventDefault();
    const words = inputText.value.trim().split(/\s+/);
    const lines = makeLines(shuffle(words));
    renderLines(lines);
}

function pickPoem(e) {
    e.preventDefault();
    const words = inputText.value.trim().split(/\s+/);
    const result = pickFew(words);
    renderLines([result.join(" ")]);
}

function clear(el) {
    while (el.firstChild) {
        el.removeChild(el.firstChild);
    }
}

function renderLines(lines) {
    clear(outputText);

    lines.forEach(line => {
        const p = document.createElement("p");
        p.textContent = line;   
        p.addEventListener("click", () => addFavorite(line));
        outputText.appendChild(p);
    });
}

let favorites = [];

function addFavorite(line) {
    favorites.push(line);
    renderFavorites();
}

function renderFavorites() {
    const container = document.getElementById("favorites");
    container.textContent = "";

    favorites.forEach(line => {
        const div = document.createElement("div");
        div.textContent = line;
        container.appendChild(div);
    });
}




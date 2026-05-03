let activeAlg = 'mathrandom';
let activeMethod = 'dada';

function togglePanel(event, id) {
    event.preventDefault();
    const panel = document.getElementById('panel-' + id);
    panel.hidden = !panel.hidden;
}

function openInfoPanel(event) {
    document.getElementById('panel-info').hidden = false;
}

const algs = {
    mathrandom: {
        title: "Math.random()",
        text: "xorshift128+",
        random(n) {
            return Array.from({ length: n }, () => Math.random());
        }
        
    },
    crypto: {
        title: "Crypto.getRandomValues()",
        text: "Browser entropy, interrupt timing, hardware noise, mouse timing"
    },
    nist: {
        title: "NIST",
        text: "Everyone in the world can reference the same entropy stream"
    },
    radio: {
        title: "Atmospheric radio noise",
        text: "Entropy yay"
    }
}

const methods = {
    dada: {
        title: "Dada",
        text: "TO MAKE A DADAIST POEM \n Take a newspaper. \n Take some scissors. \n Choose from this paper an article of the length you want to make your poem. \nCut out the article. \nNext carefully cut out each of the words that makes up this article and put them all in a bag. \nShake gently. \nNext take out each cutting one after the other. \nCopy conscientiously in the order in which they left the bag. \nThe poem will resemble you. \nAnd there you are—an infinitely original author of charming sensibility, even though unappreciated by the vulgar herd. \n—Tristan Tzara, 1920",
        renderForm() {
            const textarea = document.createElement('textarea');
            textarea.id = 'input-main';
            textarea.placeholder = 'Paste any text here...';
            return [textarea];
        },
        generate(text, randomFn) {
            const words = text.trim().split(/\s+/);
            const nums = randomFn(words.length);
            const shuffled = fisherYates(words, nums);
            return makeLines(shuffled, randomFn);
        }

    }, 
    cutup: {
        title: "Cut-Up",
        text: "Take a page. Like this page. Now cut down the middle. You have four sections: 1 2 3 4 . . . one two three four. Now rearrange the sections placing section four with section one and section two with section three. And you have a new page. Sometimes it says much the same thing. Sometimes something quite different-cutting up political speeches is an interesting exercise-in any case you will find that it says something and something quite definite."
    },
    beckett: {
        title: "Lessness",
        text: "\"Lessness\" was written when Beckett wrote sixty sentences on different pieces of paper, put them in a box, and drew them out. He then repeated the process."
    },
    verbasizer: {
        title: "Verbasizer",
        text: "It'll take the sentence, and I'll divide it up between the columns, and then when I've got say, three or four or five—sometimes I'll go as much as 20, 25 different sentences going across here, and then I'll set it to randomize. And it'll take those 20 sentences and cut in between them all the time, picking out, choosing different words from different columns, and from different rows of sentences. So what you end up with is a real kaleidoscope of meanings and topic and nouns and verbs all sort of slamming into each other."
    }
}

function makeLines(words, randomFn) {
    const lines = [];
    let i = 0;
    while (i < words.length) {
        const nums = randomFn(6);
        const len = Math.floor(nums[0] * 6) + 3;
        lines.push(words.slice(i, i + len).join(' '));
        i += len;
    }
    return lines;
}

function renderForm(methodId) {
    const form = document.getElementById('generator-form');
    form.replaceChildren();
    const elements = methods[methodId].renderForm();
    elements.forEach(el => form.appendChild(el));
}

function fisherYates(words, nums) {
    const arr = [...words];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(nums[i] * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function setInfo(divId, title, text) {
    const div = document.getElementById(divId);
    div.hidden = false; 
    div.replaceChildren();
    const titleEl = document.createElement('h3')
    titleEl.textContent = title;
    const textEl = document.createElement('p')
    textEl.textContent = text;
    div.appendChild(titleEl);
    div.appendChild(textEl);
}

function setAlg(algId) {
    activeAlg = algId;
    const info = algs[algId];
    setInfo("info-alg", info.title, info.text);
    openInfoPanel();
}

function setMethod(methodId) {
    activeMethod = methodId;
    const info = methods[methodId];
    setInfo("info-method", info.title, info.text);
    renderForm(methodId);
    openInfoPanel();
}

function getInputText() {
    const el = document.getElementById('input-main');
    return el ? el.value.trim() : '';
}

function makePoem(event) {
    event.preventDefault();
    const text = getInputText();
    if (!text) return;
    const randomFn = algs[activeAlg].random;
    const lines = methods[activeMethod].generate(text, randomFn);
    renderLines(lines);
}

document.getElementById('make-poem').addEventListener('click', makePoem);

function renderLines(lines) {
    const output = document.getElementById('output-area');
    output.replaceChildren();
    lines.forEach(line => {
        const p = document.createElement('p');
        p.textContent = line;
        output.appendChild(p);
    });
}

document.querySelectorAll('.alg-btn').forEach(button =>  {
    button.addEventListener('click', () => {
        setAlg(button.dataset.alg)
    })
})

document.querySelectorAll('.method-btn').forEach(button =>  {
    button.addEventListener('click', () => {
        setMethod(button.dataset.method)
    })
})

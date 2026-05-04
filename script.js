// ============================================================================
// TYPE CONTRACTS
// ============================================================================
//
// Poem
//   { id: number, lines: Line[], method: string, alg: string, source: string, date: string }
//
// Line
//   { id: number, text: string }
//
// Algorithm  (entries in `algorithms` registry)
//   id          string         matches the key in `algorithms`
//   title       string         user-facing label
//   text        string         explanation shown in info panel
//   color       string         accent color (hex with #) when this alg is active
//   prepare()   async fn       fetch any external entropy. No-op for local algs.
//   random(n)   sync fn        returns n floats in [0,1). Must work after prepare().
//
// Method  (entries in `methods` registry)
//   id          string
//   title       string
//   text        string
//   bgColor     string         panel background when active
//   accentColor string         button accent when active
//   textColor   string         text color when active
//   generate(input, randomFn)  returns array of line strings.
//                              `input` is a string by default (from the active source),
//                              OR whatever shape the method's readInput() returns.
//   renderForm? (optional)     if defined, the method takes over the form area
//                              and the source picker is hidden. Use this for methods
//                              that need bespoke UI (e.g. multi-column verbasizer).
//   readInput?  (optional)     if defined, called instead of source.getText() —
//                              returns whatever data shape the method needs.
//
// Source  (entries in `sources` registry)
//   id          string
//   title       string
//   text        string         info-panel description
//   renderForm(container)      builds whatever input UI this source needs
//   getText()   async fn       returns the text the user wants to remix
//
// ============================================================================
// UTILITIES
// ============================================================================

// unique id generator for poems and lines
let _idCounter = 0;
function uid() {
    return Date.now() * 1000 + (_idCounter++);
}

// fisher-yates shuffle using a stream of random floats
function fisherYates(arr, randomFn) {
    const out = [...arr];
    const nums = randomFn(out.length);
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(nums[i] * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// chunk an array of words into lines of variable length
function chunkLines(words, randomFn, minLen = 3, maxLen = 8) {
    const lines = [];
    let i = 0;
    while (i < words.length) {
        const r = randomFn(1)[0];
        const len = Math.floor(r * (maxLen - minLen + 1)) + minLen;
        const slice = words.slice(i, i + len).join(' ');
        if (slice.trim()) lines.push(slice);
        i += len;
    }
    return lines;
}

// split into sentences (keeps punctuation)
function splitSentences(text) {
    return text
        .replace(/\s+/g, ' ')
        .match(/[^.!?]+[.!?]+|\S[^.!?]*$/g)
        ?.map(s => s.trim())
        .filter(Boolean) ?? [];
}

// deterministic PRNG seeded from a 32-bit integer (Mulberry32)
// used by nist + random.org algorithms — they give us a small amount of
// real entropy, which we use as the seed for a PRNG so we have enough
// numbers to actually run methods. The entropy SOURCE is still real, the
// PRNG just stretches it.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// turn a hex string into a single 32-bit seed (xor-fold)
function hexToSeed(hex) {
    let seed = 0;
    for (let i = 0; i < hex.length; i += 8) {
        const chunk = parseInt(hex.slice(i, i + 8), 16) || 0;
        seed = (seed ^ chunk) >>> 0;
    }
    return seed;
}

// ============================================================================
// ALGORITHMS REGISTRY (entropy sources)
// ============================================================================

const algorithms = {
    mathrandom: {
        id: 'mathrandom',
        title: 'Math.random()',
        text: 'JavaScript\'s built-in pseudo-random generator. In V8 (Chrome) it\'s xorshift128+. Fast, deterministic from an internal state, not cryptographically secure but fine for shuffling.',
        color: '#c0392b',
        async prepare() {
            // no setup needed
        },
        random(n) {
            return Array.from({ length: n }, () => Math.random());
        }
    },

    crypto: {
        id: 'crypto',
        title: 'Crypto.getRandomValues()',
        text: 'The browser\'s cryptographic random source. Pulls from OS-level entropy: hardware noise, interrupt timing, mouse movement, network jitter. Suitable for keys, nonces, anything that must be unguessable.',
        color: '#2c5f7c',
        async prepare() {
            // no setup needed — the API is sync
        },
        random(n) {
            const buf = new Uint32Array(n);
            crypto.getRandomValues(buf);
            return Array.from(buf, v => v / 0x100000000);
        }
    },

    nist: {
        id: 'nist',
        title: 'NIST Randomness Beacon',
        text: 'Every 60 seconds, NIST publishes a fresh 512-bit pulse of randomness signed with their private key. Anyone in the world can reference the same value. Randomness as shared, public, canonical fact.',
        color: '#5c3a8c',
        _rng: null,
        async prepare() {
            try {
                const res = await fetch('https://beacon.nist.gov/beacon/2.0/pulse/last');
                const data = await res.json();
                const hex = data?.pulse?.outputValue ?? '';
                const seed = hexToSeed(hex) || Date.now();
                this._rng = mulberry32(seed);
            } catch (err) {
                console.warn('NIST beacon fetch failed, falling back to crypto seed', err);
                const fallback = new Uint32Array(1);
                crypto.getRandomValues(fallback);
                this._rng = mulberry32(fallback[0]);
            }
        },
        random(n) {
            if (!this._rng) this._rng = mulberry32(Date.now());
            return Array.from({ length: n }, () => this._rng());
        }
    },

    radio: {
        id: 'radio',
        title: 'Atmospheric Radio Noise (random.org)',
        text: 'random.org collects randomness from atmospheric radio noise picked up by antennas around the world. Truly non-deterministic — there is no algorithm behind it, only the weather.',
        color: '#3a7c5c',
        _rng: null,
        async prepare() {
            try {
                const res = await fetch('https://www.random.org/integers/?num=8&min=0&max=4294967295&col=1&base=10&format=plain&rnd=new');
                const text = await res.text();
                const ints = text.trim().split('\n').map(s => parseInt(s, 10)).filter(Number.isFinite);
                let seed = 0;
                for (const v of ints) seed = (seed ^ v) >>> 0;
                this._rng = mulberry32(seed || Date.now());
            } catch (err) {
                console.warn('random.org fetch failed, falling back to crypto seed', err);
                const fallback = new Uint32Array(1);
                crypto.getRandomValues(fallback);
                this._rng = mulberry32(fallback[0]);
            }
        },
        random(n) {
            if (!this._rng) this._rng = mulberry32(Date.now());
            return Array.from({ length: n }, () => this._rng());
        }
    }
};

// ============================================================================
// METHODS REGISTRY (poetic transforms)
// ============================================================================

const methods = {
    dada: {
        id: 'dada',
        title: 'Dada',
        text: 'TO MAKE A DADAIST POEM. Take a newspaper. Take some scissors. Choose from this paper an article of the length you want to make your poem. Cut out the article. Next carefully cut out each of the words that makes up this article and put them all in a bag. Shake gently. Next take out each cutting one after the other. Copy conscientiously in the order in which they left the bag. The poem will resemble you. — Tristan Tzara, 1920',
        bgColor: '#f5f0e8',
        accentColor: '#e8d5b7',
        textColor: '#c0392b',
        generate(text, randomFn) {
            const words = text.trim().split(/\s+/).filter(Boolean);
            if (!words.length) return [];
            const shuffled = fisherYates(words, randomFn);
            return chunkLines(shuffled, randomFn, 3, 7);
        }
    },

    cutup: {
        id: 'cutup',
        title: 'Cut-Up',
        text: 'Take a page. Like this page. Now cut down the middle. You have four sections: 1 2 3 4. Now rearrange the sections placing section four with section one and section two with section three. And you have a new page. — William S. Burroughs',
        bgColor: '#ede4d3',
        accentColor: '#a89274',
        textColor: '#3a2818',
        generate(text, randomFn) {
            const words = text.trim().split(/\s+/).filter(Boolean);
            if (words.length < 4) return [words.join(' ')];

            // split into 4 roughly equal sections
            const q = Math.floor(words.length / 4);
            const s1 = words.slice(0, q);
            const s2 = words.slice(q, q * 2);
            const s3 = words.slice(q * 2, q * 3);
            const s4 = words.slice(q * 3);

            // burroughs: place section 4 with section 1, section 2 with section 3
            // we interleave the pairs to make the cut visible
            const half1 = [];
            const half2 = [];
            const max1 = Math.max(s4.length, s1.length);
            const max2 = Math.max(s2.length, s3.length);
            for (let i = 0; i < max1; i++) {
                if (s4[i]) half1.push(s4[i]);
                if (s1[i]) half1.push(s1[i]);
            }
            for (let i = 0; i < max2; i++) {
                if (s2[i]) half2.push(s2[i]);
                if (s3[i]) half2.push(s3[i]);
            }
            const recombined = [...half1, ...half2];
            return chunkLines(recombined, randomFn, 4, 9);
        }
    },

    beckett: {
        id: 'beckett',
        title: 'Lessness',
        text: 'For "Lessness," Beckett wrote sixty sentences on different pieces of paper, put them in a box, and drew them out at random. Sentence boundaries are preserved — only their order is undone.',
        bgColor: '#f0ede5',
        accentColor: '#b8b0a0',
        textColor: '#2a2820',
        generate(text, randomFn) {
            const sentences = splitSentences(text);
            if (!sentences.length) return [];
            // beckett: shuffle the sentences once, preserving each sentence intact
            return fisherYates(sentences, randomFn);
        }
    },

    verbasizer: {
        id: 'verbasizer',
        title: 'Verbasizer',
        text: 'David Bowie\'s digital cut-up tool: text divided across columns, then randomized — "a real kaleidoscope of meanings and topics and nouns and verbs all sort of slamming into each other." Fill each column yourself or pull a random Wikipedia article into it. The generator walks left to right and at each position picks a word from a random column.',
        bgColor: '#e5e8f0',
        accentColor: '#7c8ca8',
        textColor: '#1a2540',
        // method-level form override: 3 columns, each independently fillable
        renderForm(container) {
            container.replaceChildren();
            const wrapper = document.createElement('div');
            wrapper.className = 'verbasizer-cols';
            for (let i = 0; i < 3; i++) {
                const col = document.createElement('div');
                col.className = 'verbasizer-col';

                const label = document.createElement('h4');
                label.textContent = `Column ${i + 1}`;
                col.appendChild(label);

                const ta = document.createElement('textarea');
                ta.className = 'verbasizer-textarea';
                ta.placeholder = 'Type or paste, or fetch a Wikipedia article →';
                ta.dataset.col = String(i);
                col.appendChild(ta);

                const status = document.createElement('p');
                status.className = 'verbasizer-status';
                col.appendChild(status);

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'verbasizer-fetch';
                btn.textContent = 'fetch random Wikipedia article';
                btn.addEventListener('click', async () => {
                    status.textContent = 'fetching...';
                    btn.disabled = true;
                    try {
                        const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/random/summary');
                        const data = await res.json();
                        ta.value = data.extract || '';
                        status.textContent = `loaded: "${data.title || 'Untitled'}"`;
                    } catch (err) {
                        console.warn('Wikipedia fetch failed', err);
                        status.textContent = 'fetch failed — try again';
                    } finally {
                        btn.disabled = false;
                    }
                });
                col.appendChild(btn);

                wrapper.appendChild(col);
            }
            container.appendChild(wrapper);
        },
        async readInput() {
            const tas = document.querySelectorAll('.verbasizer-textarea');
            return Array.from(tas).map(t => t.value.trim()).filter(Boolean);
        },
        generate(input, randomFn) {
            // input is an array of column strings (from readInput)
            const rows = Array.isArray(input)
                ? input.filter(Boolean)
                : (typeof input === 'string' && input.trim() ? [input] : []);
            if (!rows.length) return [];
            return verbasizeRows(rows, randomFn);
        }
    }
};

// helper for verbasizer — picks word at column-position i from a random row
function verbasizeRows(rows, randomFn) {
    const matrix = rows.map(r => r.split(/\s+/).filter(Boolean));
    const maxCols = Math.max(...matrix.map(r => r.length));
    if (!Number.isFinite(maxCols) || maxCols <= 0) return [];
    const out = [];
    let line = [];
    for (let col = 0; col < maxCols; col++) {
        const r = randomFn(1)[0];
        const rowIdx = Math.floor(r * matrix.length);
        const word = matrix[rowIdx][col];
        if (word) line.push(word);
        // line break every 5-9 words
        if (line.length >= 5 + Math.floor(randomFn(1)[0] * 5)) {
            out.push(line.join(' '));
            line = [];
        }
    }
    if (line.length) out.push(line.join(' '));
    return out;
}

// ============================================================================
// SOURCES REGISTRY (where text comes from)
// ============================================================================

const sources = {
    userInput: {
        id: 'userInput',
        title: 'Your own text',
        text: 'Type or paste any text. Newspapers, your own writing, an email, a recipe, a love letter — anything is grist.',
        renderForm(container) {
            container.replaceChildren();
            const ta = document.createElement('textarea');
            ta.id = 'input-main';
            ta.placeholder = 'Write or paste any text here...';
            ta.className = 'source-textarea';
            container.appendChild(ta);
        },
        async getText() {
            const el = document.getElementById('input-main');
            return el ? el.value.trim() : '';
        }
    },

    wikipedia: {
        id: 'wikipedia',
        title: 'Random Wikipedia article',
        text: 'Pulls a random article summary from Wikipedia\'s REST API. The encyclopedia as raw material — every cut-up starts with someone else\'s certainty.',
        _cached: '',
        renderForm(container) {
            container.replaceChildren();
            const wrapper = document.createElement('div');
            wrapper.className = 'source-wiki';

            const status = document.createElement('p');
            status.className = 'source-wiki-status';
            status.textContent = 'No article fetched yet.';

            const fetchBtn = document.createElement('button');
            fetchBtn.type = 'button';
            fetchBtn.className = 'source-wiki-btn';
            fetchBtn.textContent = 'Fetch a random article';

            const preview = document.createElement('div');
            preview.className = 'source-wiki-preview';
            preview.hidden = true;

            fetchBtn.addEventListener('click', async () => {
                status.textContent = 'Fetching...';
                try {
                    const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/random/summary');
                    const data = await res.json();
                    const title = data.title || 'Untitled';
                    const extract = data.extract || '';
                    sources.wikipedia._cached = extract;
                    status.textContent = `Loaded: "${title}"`;
                    preview.textContent = extract;
                    preview.hidden = false;
                } catch (err) {
                    status.textContent = 'Fetch failed. Try again.';
                    console.warn('Wikipedia fetch failed', err);
                }
            });

            wrapper.appendChild(fetchBtn);
            wrapper.appendChild(status);
            wrapper.appendChild(preview);
            container.appendChild(wrapper);
        },
        async getText() {
            return sources.wikipedia._cached || '';
        }
    }
};

// ============================================================================
// QUOTES
// ============================================================================
const quotes = {
    q1: {
        author: "Alexander R. Galloway",
        source: "Anti-Computer (2018)",
        text: `Still, what would it mean to suspend the computer? Or to oppose it? What are all the things that the computer can't do? If computers have been designed and optimized in certain ways, then would the inversion of such optimizations constitute something like an anti-computer? 
        
        The anti-computer has yet to be invented. But traces of it are found everywhere… Cryptography deploys form as a weapon against form. Such is the magic of encryption. Encryption is a kind of structure that makes life difficult for other competing structures. Encryption does not promote frictionlessness, on the contrary it produces full and complete friction at all levels. Not the quotidian friction of everyday life, but a radical friction frustrating all expression. What used to be a marginal activity practiced by hackers -- cracking password hashes -- is now the basis of an entire infrastructure. Earn a buck by cracking hashes using “brute force.”
        
        Turn your computer into an anti-computer.`
    },
    q2: {
        author: "Susan Lepselter",
        source: "The Resonance of Unseen Things: Poetics, Power, Captivity, and UFOs in the American Uncanny (2016)",
        text: "Apophenia refers to the experience of perceiving connections between random or unrelated objects. This definition, though, already contains within it a specific point of view, an assumption of power. Who decides what is really related or unrelated? Who defines whether the relations between objects-or between events, or between spectacles of dominance across various contexts—are random and arbitrary? ... In mainstream psychology, apophenia is called an \"error of perception ... the tendency to interpret random patterns as meaningful\" But the people I write about here cultivate apophenia, not as an \"error,\" but instead as a way to begin seeing those things that have become invisible."
    },
    q3: {
        author: "Langdon Winner",
        source: "Do Artifacts Have Politics? (1980)",
        text: "The machines, structures, and systems of modern material culture cannot be accurately judged only for their contributions of efficiency and productivity, or merely for their positive and negative side effects, but also for the ways in which they can embody specific forms of power and authority."
    },
    q4: {
        author: "Véronique Altglas",
        source: "From Yoga to Kabbalah: Religious Exoticism andthe Logics of Bricolage (2014)",
        text: "In contemporary society, individuals increasingly craft their religious life and identity by pickingand mixing from a wide range of religious traditions. This has been called bricolage. Bricolage is a French common word that has no direct translation in the English language. It designates activities of fabricating, repairing, and installing—something like “DIY.” It conveys the idea that this practice is amateurish or not serious—the verb bricoler in some contexts can be translated as “fiddling.” Lévi-Strauss (1966) originally used the term as a metaphor to explain the ways in which mythological thought creates meaning and “fixes” myths by replacing missing or forgotten elements with residual components. In short, for Levi-Strauss, mythical meaning-making bricoleurs combine their imagination with whatever knowledge tools they have at-hand in their repertoire (e.g., ritual, observation, social practices) and with whatever artifacts are available in their given context (i.e., discourses, institutions, and dominant knowledges) to meet diverse knowledge-production tasks."
    },
    q5: {
        author: "Aristotle",
        source: "The Politics of Aristotle (ed. 1885)",
        text: `To be always seeking after the useful does not become free and exalted souls.`
    }
}
const quoteArray = Object.values(quotes)

const track = document.querySelector(".carousel-track")

let currentIndex = 0

quoteArray.forEach(quote => {
  const card = document.createElement("div")
  card.classList.add("quote-card")

  card.innerHTML = `
    <p class="quote-text">${quote.text}</p>
    <div class="quote-author">${quote.author}</div>
    <div class="quote-source">${quote.source}</div>
  `

  track.appendChild(card)
})

const cards = document.querySelectorAll(".quote-card")

function updateCarousel() {
  const cardWidth = cards[0].offsetWidth + 20
  track.style.transform = `translateX(-${currentIndex * cardWidth}px)`
}

document.querySelector("#next").addEventListener("click", () => {
  if (currentIndex < quoteArray.length - 2) {
    currentIndex++
    updateCarousel()
  }
})

document.querySelector("#prev").addEventListener("click", () => {
  if (currentIndex > 0) {
    currentIndex--
    updateCarousel()
  }
})


// ============================================================================
// LINKS
// ============================================================================

const links = {
    uselessconversionbot: {
        id: "uselessconversionbot",
        title: "Useless Conversion Bot",
        description: "This Reddit bot looks for useful and easy to share metric units and turns them into something more interesting. 2.00 meters ≈ 2.11405 x 10-16 light years. 210 cm ≈ 20.66929 hands. 3 cm ≈ 0.00027 football fields. 17 kg ≈ 0.39871 bags portland cement.",
        link: "https://www.reddit.com/user/UselessConversionBot/"
    },
    lavalamps: {
        id: "lavalamps",
        title: "Cloudflare's Lava Lamps",
        description: "Cloudflare uses a Wall of Entropy consisting of 100 lava lamps in its San Francisco headquarters to help secure internet encryption.  A camera continuously monitors the unpredictable movement of the wax, converting the visual chaos into random data (entropy) that serves as a seed for generating secure cryptographic keys.",
        link: "https://www.cloudflare.com/learning/ssl/lava-lamp-encryption/"
    },
    conceptnet: {
        id: "conceptnet",
        title: "ConceptNet",
        description: "ConceptNet is a freely-available semantic network, designed to help computers understand the meanings of words that people use. ConceptNet originated from the crowdsourcing project Open Mind Common Sense, which was launched in 1999 at the MIT Media Lab. It has since grown to include knowledge from other crowdsourced resources, expert-created resources, and games with a purpose.",
        link: "https://conceptnet.io/"
    },
    haiku: {
        id: "haiku",
        title: "haikU",
        description: "haikU is a browser-based, audience participatory, haiku poem project. The project displays randomly generated haiku poems, and allows the Internet audience to contribute to the project's database of haiku lines. The project is known as a work of electronic literature and for its use of an evolving database, and for the relative coherence of its output.",
        link: "https://preneo.org/nwylde/haikU/index.shtml"
    },
    babel: {
        id: "babel",
        title: "The Library of Babel",
        description: "The Library of Babel simulates Jorge Luis Borges' 1941 short story by generating every possible combination of text using a fixed alphabet.  ecause storing the entire library is physically impossible, the site uses a deterministic algorithm to generate pages on demand based on a unique coordinate system, ensuring the same text always appears at the same location. Journalist Jerry Adler said \"It just may be the most fascinatingly useless invention in history.\"",
        link: "https://libraryofbabel.info/"
    },
    listentowikipedia: {
        id: "listentowikipedia",
        title: "Listen to Wikipedia",
        description: "Listen to Wikipedia is a visualization and sonification of Wikipedia's live recent changes data. Although the sounds feel random from a traditional musical context, they indicate addition to (bells) or subtraction from (strings) a Wikipedia articles, and the pitch is inversely proportional to the size of the edit (a lower pitch means a bigger edit). Green circles show edits from unregistered contributors, and purple circles mark edits performed by automated bots.",
        link: "https://listen.hatnote.com/"
    }
}
const grid = document.querySelector("#links-grid")

Object.values(links).forEach(item => {
  const card = document.createElement("div")
  card.classList.add("link-card")

  const title = document.createElement("h2")
  title.classList.add("link-title")
  title.textContent = item.title

  const description = document.createElement("p")
  description.classList.add("link-description")
  description.textContent = item.description

  const anchor = document.createElement("a")
  anchor.classList.add("link-anchor")

  anchor.href = item.link
  anchor.textContent = "Visit site"
  anchor.target = "_blank"

  card.appendChild(title)
  card.appendChild(description)
  card.appendChild(anchor)

  grid.appendChild(card)
})

// ============================================================================
// STATE
// ============================================================================

let activeAlg = 'mathrandom';
let activeMethod = 'dada';
let activeSource = 'userInput';

// ============================================================================
// SETTERS — change active alg/method/source and update the UI
// ============================================================================

function setAlg(algId) {
    if (!algorithms[algId]) return;
    activeAlg = algId;
    const alg = algorithms[algId];
    setInfo('info-alg', alg.title, alg.text);
    document.documentElement.style.setProperty('--alg-color', alg.color);
}

function setMethod(methodId) {
    if (!methods[methodId]) return;
    activeMethod = methodId;
    const method = methods[methodId];
    setInfo('info-method', method.title, method.text);
    setGeneratorColor(method.bgColor, method.accentColor, method.textColor);
    // highlight active method button
    document.querySelectorAll('.method-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.method === methodId);
    });
    renderActiveForm();
}

function setSource(sourceId) {
    if (!sources[sourceId]) return;
    activeSource = sourceId;
    const source = sources[sourceId];
    setInfo('info-source', source.title, source.text);
    // highlight active source button
    document.querySelectorAll('.source-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.source === sourceId);
    });
    renderActiveForm();
}

// Renders whichever form is currently appropriate.
// If the active method has its own renderForm, the method takes over and the
// source picker is hidden. Otherwise, the active source's form is rendered.
function renderActiveForm() {
    const container = document.getElementById('generator-form');
    if (!container) return;
    const method = methods[activeMethod];
    const sourceBlock = document.getElementById('source-block');
    const infoSource = document.getElementById('info-source');
    if (method && typeof method.renderForm === 'function') {
        method.renderForm(container);
        if (sourceBlock) sourceBlock.hidden = true;
        if (infoSource) infoSource.hidden = true;
    } else {
        const source = sources[activeSource];
        if (source) source.renderForm(container);
        if (sourceBlock) sourceBlock.hidden = false;
        if (infoSource) infoSource.hidden = false;
    }
}

function setInfo(divId, title, text) {
    const div = document.getElementById(divId);
    if (!div) return;
    div.hidden = false;
    div.replaceChildren();
    const titleEl = document.createElement('h4');
    titleEl.textContent = title;
    const textEl = document.createElement('p');
    textEl.textContent = text;
    div.appendChild(titleEl);
    div.appendChild(textEl);
}

function setGeneratorColor(bgColor, accentColor, textColor) {
    const generator = document.getElementById('generator');
    if (!generator) return;
    generator.style.backgroundColor = bgColor;
    generator.style.color = textColor;
    const btn = document.getElementById('make-poem');
    if (btn) {
        btn.style.backgroundColor = accentColor;
        btn.style.color = textColor;
    }
}

// ============================================================================
// MAKE POEM — async orchestrator: source → entropy → method → render
// ============================================================================

async function makePoem(event) {
    if (event) event.preventDefault();
    const btn = document.getElementById('make-poem');
    const originalText = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }

    try {
        const method = methods[activeMethod];
        // method may override input gathering (e.g. verbasizer reads multiple columns)
        const input = (typeof method.readInput === 'function')
            ? await method.readInput()
            : await sources[activeSource].getText();

        const hasContent = Array.isArray(input)
            ? input.some(s => s && s.trim())
            : (typeof input === 'string' && input.trim());
        if (!hasContent) {
            renderEmpty('Add some text first (or fetch an article).');
            return;
        }

        await algorithms[activeAlg].prepare();
        const randomFn = algorithms[activeAlg].random.bind(algorithms[activeAlg]);

        const lineStrings = method.generate(input, randomFn);
        if (!lineStrings.length) {
            renderEmpty('No poem produced — try a longer text.');
            return;
        }

        const poem = {
            id: uid(),
            lines: lineStrings.map(t => ({ id: uid(), text: t })),
            method: activeMethod,
            alg: activeAlg,
            source: activeSource,
            date: new Date().toISOString()
        };

        renderPoem(poem);
    } catch (err) {
        console.error(err);
        renderEmpty('Something went wrong. Check the console.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = originalText || 'Randomize'; }
    }
}

function renderEmpty(message) {
    const output = document.getElementById('output-area');
    output.replaceChildren();
    const p = document.createElement('p');
    p.className = 'output-empty';
    p.textContent = message;
    output.appendChild(p);
}

// ============================================================================
// RENDER POEM (the live, interactive output)
// ============================================================================

// shared tooltip element
const tooltip = document.createElement('div');
tooltip.id = 'tooltip';
tooltip.hidden = true;
document.body.appendChild(tooltip);

document.addEventListener('mousemove', (e) => {
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top = (e.clientY + 14) + 'px';
});

function showTooltip(text) {
    tooltip.textContent = text;
    tooltip.hidden = false;
}

function hideTooltip() {
    tooltip.hidden = true;
}

function renderPoem(poem) {
    const output = document.getElementById('output-area');
    output.replaceChildren();

    const poemEl = document.createElement('div');
    poemEl.className = 'poem';
    poemEl.dataset.poemId = poem.id;

    // toolbar (top-right): edit + save
    const toolbar = document.createElement('div');
    toolbar.className = 'poem-toolbar';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'poem-tool-btn';
    editBtn.textContent = 'edit';
    editBtn.addEventListener('click', () => enterEditMode(poemEl, poem));
    toolbar.appendChild(editBtn);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'poem-tool-btn';
    saveBtn.textContent = 'save poem';
    saveBtn.addEventListener('click', () => {
        savePoemToStorage(poem);
        const original = saveBtn.textContent;
        saveBtn.textContent = 'saved ✓';
        saveBtn.disabled = true;
        setTimeout(() => { saveBtn.textContent = original; saveBtn.disabled = false; }, 1400);
        renderSavedPoems();
    });
    toolbar.appendChild(saveBtn);

    poemEl.appendChild(toolbar);

    // lines (each line is independently hoverable + click-to-favorite)
    poem.lines.forEach(line => {
        const p = document.createElement('p');
        p.className = 'poem-line';
        p.textContent = line.text;

        p.addEventListener('mouseenter', () => showTooltip('favorite this line'));
        p.addEventListener('mouseleave', hideTooltip);
        p.addEventListener('click', () => {
            saveLineToStorage(line);
            showTooltip('saved');
            setTimeout(hideTooltip, 1200);
            renderFavoriteLines();
        });

        poemEl.appendChild(p);
    });

    output.appendChild(poemEl);
}

// switch a poem element into edit mode — replaces lines with a textarea
function enterEditMode(poemEl, poem) {
    hideTooltip();
    const ta = document.createElement('textarea');
    ta.className = 'poem-editor';
    ta.value = poem.lines.map(l => l.text).join('\n');

    const commit = () => {
        poem.lines = ta.value
            .split('\n')
            .map(t => ({ id: uid(), text: t }));
        renderPoem(poem);
    };

    ta.addEventListener('keydown', (ev) => {
        // Enter exits edit mode. Shift+Enter inserts a newline.
        if (ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault();
            commit();
        } else if (ev.key === 'Escape') {
            ev.preventDefault();
            commit();
        }
    });
    ta.addEventListener('blur', commit);

    poemEl.replaceChildren(ta);
    ta.focus();
    // place cursor at end
    ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ============================================================================
// STORAGE
// ============================================================================

function loadPoems() {
    try {
        return JSON.parse(localStorage.getItem('poems') || '[]');
    } catch { return []; }
}

function loadFavoriteLines() {
    try {
        return JSON.parse(localStorage.getItem('lines') || '[]');
    } catch { return []; }
}

function savePoemToStorage(poem) {
    const poems = loadPoems();
    // dedupe by id
    if (!poems.some(p => p.id === poem.id)) {
        poems.push(poem);
        localStorage.setItem('poems', JSON.stringify(poems));
    }
    renderSavedPoems();
}

function saveLineToStorage(line) {
    const lines = loadFavoriteLines();
    lines.push({ id: uid(), text: line.text, date: new Date().toISOString() });
    localStorage.setItem('lines', JSON.stringify(lines));
    renderFavoriteLines();
}

function deletePoem(id, event) {
   
    const poems = loadPoems().filter(p => p.id !== id);
    localStorage.setItem('poems', JSON.stringify(poems));
    renderSavedPoems();
     event.preventDefault();
}

function deleteLine(id, event) {
    
    const lines = loadFavoriteLines().filter(l => l.id !== id);
    localStorage.setItem('lines', JSON.stringify(lines));
    renderFavoriteLines();
     event.preventDefault();
}

// ============================================================================
// SAVED POEMS / FAVORITE LINES VIEWS
// ============================================================================

function renderSavedPoems() {
    const container = document.getElementById('saved-poems-list');
    if (!container) return;
    container.replaceChildren();

    const poems = loadPoems();
    if (!poems.length) {
        const p = document.createElement('p');
        p.className = 'empty-msg';
        p.textContent = 'No saved poems yet.';
        container.appendChild(p);
        return;
    }

    // newest first
    poems.slice().reverse().forEach(poem => {
        const card = document.createElement('article');
        card.className = 'saved-poem';

        const meta = document.createElement('div');
        meta.className = 'saved-meta';
        const date = new Date(poem.date);
        meta.textContent = `${methods[poem.method]?.title ?? poem.method} · ${algorithms[poem.alg]?.title ?? poem.alg} · ${date.toLocaleDateString()}`;

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'saved-delete';
        del.textContent = '×';
        del.title = 'delete';
        del.addEventListener('click', () => deletePoem(poem.id));

        const lines = document.createElement('div');
        lines.className = 'saved-lines';
        poem.lines.forEach(line => {
            const p = document.createElement('p');
            p.textContent = line.text;
            lines.appendChild(p);
        });

        card.appendChild(meta);
        card.appendChild(del);
        card.appendChild(lines);
        container.appendChild(card);
    });
}

function renderFavoriteLines() {
    const container = document.getElementById('favorite-lines-list');
    if (!container) return;
    container.replaceChildren();

    const lines = loadFavoriteLines();
    if (!lines.length) {
        const p = document.createElement('p');
        p.className = 'empty-msg';
        p.textContent = 'No favorite lines yet.';
        container.appendChild(p);
        return;
    }

    lines.slice().reverse().forEach(line => {
        const row = document.createElement('div');
        row.className = 'fav-line';

        const text = document.createElement('p');
        text.textContent = line.text;

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'saved-delete';
        del.textContent = '×';
        del.addEventListener('click', () => deleteLine(line.id));

        row.appendChild(text);
        row.appendChild(del);
        container.appendChild(row);
    });
}

// ============================================================================
// INIT + EVENT WIRING
// ============================================================================

function buildAlgSelect() {
    const select = document.getElementById('alg-select');
    if (!select) return;
    select.replaceChildren();
    Object.values(algorithms).forEach(alg => {
        const opt = document.createElement('option');
        opt.value = alg.id;
        opt.textContent = alg.title;
        select.appendChild(opt);
    });
}

function buildMethodButtons() {
    const container = document.getElementById('method-selector');
    if (!container) return;
    container.replaceChildren();
    Object.values(methods).forEach(method => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'method-btn';
        btn.dataset.method = method.id;
        btn.textContent = method.title;
        btn.addEventListener('click', () => setMethod(method.id));
        container.appendChild(btn);
    });
}

function buildSourceButtons() {
    const container = document.getElementById('source-selector');
    if (!container) return;
    container.replaceChildren();
    Object.values(sources).forEach(source => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'source-btn';
        btn.dataset.source = source.id;
        btn.textContent = source.title;
        btn.addEventListener('click', () => setSource(source.id));
        container.appendChild(btn);
    });
}

function init() {
    buildAlgSelect();
    buildMethodButtons();
    buildSourceButtons();

    document.getElementById('alg-select')?.addEventListener('change', e => setAlg(e.target.value));
    document.getElementById('make-poem')?.addEventListener('click', makePoem);

    addScrambleButton();
    scrambleStyle();          // random look on every load — the poem will resemble you

    setAlg('mathrandom');
    setMethod('dada');
    setSource('userInput');
    renderSavedPoems();
    renderFavoriteLines();

    // keep the lists synced if storage changes (other tabs, dev tools, etc.)
    window.addEventListener('storage', (e) => {
        if (e.key === 'poems' || e.key === null) renderSavedPoems();
        if (e.key === 'lines' || e.key === null) renderFavoriteLines();
    });
    // re-render when the tab regains focus (defensive — covers any missed updates)
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            renderSavedPoems();
            renderFavoriteLines();
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}


// ============================================================================
// STYLE SCRAMBLER
// ============================================================================

const styleThemes = [
    { name: 'offset',     paper: '#f2eee5', ink: '#1f1e1d', muted: '#8b8680', rule: '#d8d2c6' },
    { name: 'ditto',      paper: '#e4ecf8', ink: '#0e1e3a', muted: '#5070a8', rule: '#a8c0dc' },
    { name: 'risograph',  paper: '#eef5e0', ink: '#162616', muted: '#4a7058', rule: '#b0d090' },
    { name: 'spirit',     paper: '#f5f0ff', ink: '#220845', muted: '#7050a8', rule: '#c8b0e8' },
    { name: 'sepia',      paper: '#f9f2de', ink: '#2c1808', muted: '#7a5535', rule: '#d4b080' },
    { name: 'newsprint',  paper: '#f2f0e8', ink: '#141414', muted: '#606060', rule: '#d0cec0' },
    { name: 'cream',      paper: '#fef9f0', ink: '#2a2010', muted: '#9a8870', rule: '#e0d0b8' },
    { name: 'chalkboard', paper: '#141e14', ink: '#e0f0cc', muted: '#88b868', rule: '#284028' },
    { name: 'blueprint',  paper: '#0a1828', ink: '#c8e4fa', muted: '#6090c0', rule: '#183860' },
    { name: 'darkroom',   paper: '#1a0808', ink: '#fae0d0', muted: '#c07060', rule: '#501818' },
    { name: 'midnight',   paper: '#0c0c1e', ink: '#e4dcff', muted: '#8878c8', rule: '#242048' },
    { name: 'telegraph',  paper: '#080e08', ink: '#b0f0b0', muted: '#60c060', rule: '#102810' },
];

const fontThemes = [
    { display: '"Base", sans-serif',      heading: '"Terminal Grotesque", monospace', ui: '"Terminal Grotesque", monospace' },
    { display: '"Brush", serif',           heading: '"Base", sans-serif',              ui: '"Base", sans-serif' },
    { display: '"Bubble", sans-serif',     heading: '"Ring", sans-serif',              ui: '"Base", sans-serif' },
    { display: '"Cube", monospace',        heading: '"Stitches", monospace',           ui: '"Terminal Grotesque", monospace' },
    { display: '"Pearl", serif',           heading: '"Pearl", serif',                  ui: '"Terminal Grotesque", monospace' },
    { display: '"Ring", sans-serif',       heading: '"Pearl", serif',                  ui: '"Base", sans-serif' },
    { display: '"Cloud", sans-serif',      heading: '"Cloud", sans-serif',             ui: '"Base", sans-serif' },
    { display: '"Stitches", sans-serif',   heading: '"Cube", monospace',               ui: '"Terminal Grotesque", monospace' },
    { display: '"Base", sans-serif',       heading: '"Brush", serif',                  ui: '"Terminal Grotesque", monospace' },
    { display: '"Bubble", sans-serif',     heading: '"Messier", sans-serif',           ui: '"Base", sans-serif' },
];

const borderThemes = [
    { style: 'solid',  radius: '0px' },
    { style: 'dashed', radius: '0px' },
    { style: 'solid',  radius: '0px' },
    { style: 'double', radius: '0px' },
    { style: 'dashed', radius: '0px' },
    { style: 'dotted', radius: '0px' },
    { style: 'solid',  radius: '0px' },
];

let _lastColorIdx = -1;
let _lastFontIdx  = -1;

function scrambleStyle() {
    const r = document.documentElement;

    // pick color theme (no immediate repeat)
    let ci;
    do { ci = Math.floor(Math.random() * styleThemes.length); } while (ci === _lastColorIdx && styleThemes.length > 1);
    _lastColorIdx = ci;
    const c = styleThemes[ci];

    // pick font theme (no immediate repeat)
    let fi;
    do { fi = Math.floor(Math.random() * fontThemes.length); } while (fi === _lastFontIdx && fontThemes.length > 1);
    _lastFontIdx = fi;
    const f = fontThemes[fi];

    // pick border theme
    const b = borderThemes[Math.floor(Math.random() * borderThemes.length)];

    // apply colors
    r.style.setProperty('--paper', c.paper);
    r.style.setProperty('--ink',   c.ink);
    r.style.setProperty('--muted', c.muted);
    r.style.setProperty('--rule',  c.rule);

    // apply fonts
    r.style.setProperty('--font-display', f.display);
    r.style.setProperty('--font-heading', f.heading);
    r.style.setProperty('--font-ui',      f.ui);

    // apply border style
    r.style.setProperty('--border-style', b.style);
    r.style.setProperty('--card-radius',  b.radius);

    // clear any method-specific inline styles on the generator
    // so the new theme colours show through
    const gen = document.getElementById('generator');
    if (gen) { gen.style.backgroundColor = ''; gen.style.color = ''; }
    const makeBtn = document.getElementById('make-poem');
    if (makeBtn) { makeBtn.style.backgroundColor = ''; makeBtn.style.color = ''; }
}

function addScrambleButton() {
    const nav = document.getElementById('main-nav');
    if (!nav) return;
    const btn = document.createElement('button');
    btn.id = 'scramble-style';
    btn.textContent = 'RANDOMIZE';
    btn.addEventListener('click', scrambleStyle);
    nav.appendChild(btn);
}

// ============================================================================
// EXTRAS
// ============================================================================


const navLinks = document.querySelectorAll("#main-nav a");

navLinks.forEach(link => {
  link.addEventListener("mouseenter", () => {
    const rotation = Math.random() * 30 - 15; // -15deg to +15deg
    link.style.transform = `rotate(${rotation}deg)`;
  });

  link.addEventListener("mouseleave", () => {
    link.style.transform = "rotate(0deg)";
  });
});
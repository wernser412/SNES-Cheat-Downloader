// ==UserScript==
// @name         SNES Downloader PRO 👑
// @namespace    http://tampermonkey.net/
// @description  Descargar CHEAT de SNES de gamehacking.org
// @version      2026.07.15
// @author       wernser412
// @downloadURL  https://github.com/wernser412/SNES-Cheat-Downloader/raw/refs/heads/main/Snes-downloader-pro.user.js
// @icon         https://github.com/wernser412/SNES-Cheat-Downloader/raw/refs/heads/main/ICONO.ico
// @author       wernser412
// @match        https://gamehacking.org/system/snes/all/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const delay = ms => new Promise(r => setTimeout(r, ms));

    // ---------- Config ----------
    const FETCH_TIMEOUT_MS = 20000;   // si una petición tarda más de esto, se aborta
    const MAX_RETRIES = 2;            // reintentos por petición fallida/lenta
    const DELAY_BETWEEN_GAMES = 500;
    const DELAY_BETWEEN_GROUPS = 150;
    const MAX_PAGES_FALLBACK = 400;   // usado solo si no se puede autodetectar el total de páginas

    let running = false;
    let cancelled = false;
    let processed = 0;
    let totalGames = null; // null = desconocido hasta autodetectar

    // ---------- UI ----------
    function createUI() {
        if (document.getElementById('gh-ui')) return;

        const box = document.createElement('div');
        box.id = 'gh-ui';
        box.style = `
            position:fixed; top:10px; right:10px; width:320px;
            background:#111; color:#0f0; padding:10px; font-size:12px;
            z-index:999999; border:1px solid #0f0; font-family:monospace;
        `;
        box.innerHTML = `
            <div><b>SNES Downloader v5</b></div>

            <div id="gh-config" style="margin-top:8px;">
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                    <input type="checkbox" id="gh-allpages" checked/>
                    Todas las páginas (autodetectar)
                </label>

                <div id="gh-range" style="display:none; margin-top:6px; gap:6px;">
                    <div style="display:flex; gap:6px; align-items:center;">
                        <label style="width:45px;">Desde</label>
                        <input type="number" id="gh-from" value="0" min="0" style="width:70px; color:#000;"/>
                        <label style="width:35px;">Hasta</label>
                        <input type="number" id="gh-to" value="10" min="0" style="width:70px; color:#000;"/>
                    </div>
                </div>

                <button id="gh-start" style="margin-top:8px;width:100%;background:#050;color:#fff;border:1px solid #0f0;padding:6px;cursor:pointer;">
                    ▶ Iniciar descarga
                </button>
            </div>

            <div id="gh-progress" style="display:none; margin-top:8px;">
                <div id="status">Listo</div>
                <div id="log" style="max-height:120px; overflow-y:auto; background:#000; margin-top:5px; padding:4px; font-size:10px; color:#8f8;"></div>
                <div style="background:#333;height:10px;margin-top:5px;">
                    <div id="bar" style="background:#0f0;height:10px;width:0%"></div>
                </div>
                <div id="percent">0%</div>
                <button id="gh-stop" style="margin-top:6px;width:100%;background:#500;color:#fff;border:1px solid #f00;padding:4px;cursor:pointer;">
                    ⏹ Detener
                </button>
            </div>
        `;
        document.body.appendChild(box);

        const allpagesCheckbox = document.getElementById('gh-allpages');
        const rangeDiv = document.getElementById('gh-range');
        rangeDiv.style.display = allpagesCheckbox.checked ? 'none' : 'flex';
        rangeDiv.style.flexDirection = 'column';

        allpagesCheckbox.addEventListener('change', () => {
            rangeDiv.style.display = allpagesCheckbox.checked ? 'none' : 'flex';
        });

        document.getElementById('gh-start').addEventListener('click', () => {
            const allPages = document.getElementById('gh-allpages').checked;
            const fromPage = parseInt(document.getElementById('gh-from').value, 10) || 0;
            const toPage = parseInt(document.getElementById('gh-to').value, 10) || 0;

            document.getElementById('gh-config').style.display = 'none';
            document.getElementById('gh-progress').style.display = 'block';

            run({ allPages, fromPage, toPage });
        });

        document.getElementById('gh-stop').addEventListener('click', () => {
            cancelled = true;
            log('Cancelación solicitada por el usuario...');
        });
    }

    function updateUI(text) {
        const el = document.getElementById('status');
        if (el) el.innerText = text;
        console.log('[SNES Downloader]', text);
    }

    function log(text) {
        const el = document.getElementById('log');
        if (el) {
            const line = document.createElement('div');
            line.textContent = text;
            el.appendChild(line);
            el.scrollTop = el.scrollHeight;
        }
        console.log('[SNES Downloader]', text);
    }

    function updateProgress(current, total) {
        const percent = total ? Math.min(100, Math.floor((current / total) * 100)) : 0;
        const bar = document.getElementById('bar');
        const pct = document.getElementById('percent');
        if (bar) bar.style.width = percent + '%';
        if (pct) pct.innerText = percent + '%';
    }

    // ---------- Helpers ----------
    function cleanName(name) {
        return name.replace(/[<>:"/\\|?*]+/g, '_').trim();
    }

    // Descarga un blob usando un <a download> nativo, sin pasar por GM_download.
    // Esto evita el error "not_whitelisted" que Tampermonkey lanza al chequear
    // el origen de las URLs blob: contra la whitelist de @connect.
    function downloadBlobNative(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function getGameLinks(doc) {
        const links = [...doc.querySelectorAll('a[href*="/game/"]')]
            .map(a => a.href)
            .filter((h, i, arr) => arr.indexOf(h) === i); // dedupe
        return links;
    }

    function extractGamID(html) {
        const m = html.match(/gamID:\s*(\d+)/);
        return m ? m[1] : null;
    }

    function extractGroups(html) {
        return [...new Set([...html.matchAll(/grpID:\s*(\d+)/g)].map(m => m[1]))];
    }

    function extractRomName(doc) {
        const select = doc.querySelector('#filename');
        if (select && select.value) return cleanName(select.value);
        const chosen = doc.querySelector('#filename_chosen span');
        if (chosen && chosen.innerText.trim()) return cleanName(chosen.innerText);
        const title = doc.querySelector('title');
        if (title && title.innerText.trim()) return cleanName(title.innerText.replace('GameHacking.org |', ''));
        return 'game_' + Date.now();
    }

    function parseCheats(doc) {
        const cheats = [];
        doc.querySelectorAll('pre').forEach(pre => {
            const codes = pre.innerText.trim().split('\n')
                .map(c => c.replace(':', '=').trim())
                .filter(Boolean)
                .filter(c => !c.includes('??')); // descarta códigos con valores sin completar
            if (!codes.length) return;

            let name = 'Cheat';
            const row = pre.closest('tr');
            if (row) {
                const label = row.querySelector('label');
                if (label) name = label.innerText.trim();
                const author = row.querySelector('small a');
                if (author && !name.includes('by')) name += ' by ' + author.innerText.trim();
            }
            cheats.push({ name, codes });
        });
        return cheats;
    }

    function format(cheats) {
        return cheats.map(c =>
`cheat
  name: ${c.name}
  code: ${c.codes.join(' + ')}
`).join('\n');
    }

    // ---------- Networking with timeout + retries ----------
    async function fetchText(url, attempt = 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, credentials: 'same-origin' });
            clearTimeout(timer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (err) {
            clearTimeout(timer);
            if (attempt <= MAX_RETRIES && !cancelled) {
                log(`⚠️ Reintentando (${attempt}/${MAX_RETRIES}) ${url.slice(0, 60)}... (${err.message})`);
                await delay(1000 * attempt);
                return fetchText(url, attempt + 1);
            }
            throw err;
        }
    }

    // El sitio carga los códigos vía POST a /modules/game.php (jQuery fillGroup()),
    // no vía GET a ajax/getCodes.php como en la versión vieja del sitio.
    async function fetchGroupCodes(gamID, grpID, attempt = 1) {
        const body = new URLSearchParams();
        body.append('gamID', gamID);
        body.append('grpID', grpID);
        // Estos 4 campos replican el objeto "filter" que manda fillGroup() en el sitio
        body.append('filter[name]', '');
        body.append('filter[format]', 'original');
        body.append('filter[enc]', '');
        body.append('filter[hacker]', '');

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch('https://gamehacking.org/modules/game.php', {
                method: 'POST',
                signal: controller.signal,
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: body.toString()
            });
            clearTimeout(timer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (err) {
            clearTimeout(timer);
            if (attempt <= MAX_RETRIES && !cancelled) {
                log(`⚠️ Reintentando grupo ${grpID} (${attempt}/${MAX_RETRIES})... (${err.message})`);
                await delay(1000 * attempt);
                return fetchGroupCodes(gamID, grpID, attempt + 1);
            }
            throw err;
        }
    }

    async function fetchDoc(url) {
        const html = await fetchText(url);
        return { doc: new DOMParser().parseFromString(html, 'text/html'), html };
    }

    // ---------- Page-count autodetection ----------
    async function detectMaxPage() {
        try {
            const { doc } = await fetchDoc('https://gamehacking.org/system/snes/all/0');
            const pageLinks = [...doc.querySelectorAll('a[href*="/system/snes/all/"]')]
                .map(a => {
                    const m = a.getAttribute('href').match(/\/all\/(\d+)/);
                    return m ? parseInt(m[1], 10) : null;
                })
                .filter(n => n !== null);
            if (pageLinks.length) {
                const max = Math.max(...pageLinks);
                log(`Última página detectada automáticamente: ${max}`);
                return max;
            }
        } catch (err) {
            log('No se pudo autodetectar el número de páginas: ' + err.message);
        }
        log(`Usando límite de respaldo: ${MAX_PAGES_FALLBACK} páginas`);
        return MAX_PAGES_FALLBACK;
    }

    // ---------- Core processing ----------
    async function processGame(url) {
        const { doc, html } = await fetchDoc(url);

        const gamID = extractGamID(html);
        const groups = extractGroups(html);

        let all = [...parseCheats(doc)];

        for (const g of groups) {
            if (cancelled) break;
            try {
                const text = await fetchGroupCodes(gamID, g);
                const sub = new DOMParser().parseFromString(text, 'text/html');
                all.push(...parseCheats(sub));
            } catch (err) {
                log(`⚠️ Grupo ${g} falló para gamID ${gamID}: ${err.message}`);
            }
            await delay(DELAY_BETWEEN_GROUPS);
        }

        if (!all.length) return false;

        const name = extractRomName(doc);
        const content = format(all);

        const blob = new Blob([content], { type: 'text/plain' });
        try {
            downloadBlobNative(blob, name + '.cht');
        } catch (err) {
            log(`❌ Falló descarga de ${name}.cht: ${err.message}`);
        }
        return true;
    }

    async function run({ allPages, fromPage, toPage }) {
        if (running) { log('Ya está corriendo.'); return; }
        running = true;
        cancelled = false;
        processed = 0;

        updateUI('Preparando...');

        let startPage, maxPage;

        if (allPages) {
            updateUI('Detectando número de páginas...');
            startPage = 0;
            maxPage = await detectMaxPage();
        } else {
            startPage = Math.max(0, Math.min(fromPage, toPage));
            maxPage = Math.max(fromPage, toPage);
            log(`Rango manual: páginas ${startPage} a ${maxPage}`);
        }

        totalGames = null; // se irá acumulando página a página, no en un pase separado

        let gamesWithCheats = 0;
        let gamesSeen = 0;

        for (let page = startPage; page <= maxPage; page++) {
            if (cancelled) break;

            updateUI(`Página ${page}/${maxPage}`);
            updateProgress(page - startPage, (maxPage - startPage) + 1);

            let doc;
            try {
                ({ doc } = await fetchDoc(`https://gamehacking.org/system/snes/all/${page}`));
            } catch (err) {
                log(`❌ No se pudo cargar la página ${page}: ${err.message}`);
                continue;
            }

            const links = getGameLinks(doc);
            if (links.length === 0) {
                log(`⚠️ Página ${page} no tiene enlaces de juegos (selector podría estar desactualizado, o llegamos al final).`);
            }

            for (const link of links) {
                if (cancelled) break;
                gamesSeen++;
                updateUI(`Juego ${gamesSeen} (página ${page}/${maxPage})`);

                try {
                    const got = await processGame(link);
                    if (got) gamesWithCheats++;
                    processed = gamesWithCheats;
                } catch (err) {
                    log(`❌ Error procesando ${link}: ${err.message}`);
                }

                if (gamesSeen % 25 === 0) {
                    log(`Progreso: ${gamesSeen} juegos revisados, ${gamesWithCheats} con cheats guardados.`);
                }

                await delay(DELAY_BETWEEN_GAMES);
            }
        }

        updateProgress(1, 1);
        log(`Finalizado. Juegos revisados: ${gamesSeen}. Juegos con cheats: ${gamesWithCheats}.`);

        if (gamesWithCheats === 0) {
            updateUI('⚠️ Terminado sin cheats encontrados — revisa selectores del sitio.');
            running = false;
            return;
        }

        updateUI(`✅ Completado — ${gamesWithCheats} archivos .cht descargados`);
        running = false;
    }

    GM_registerMenuCommand('🚀 Abrir SNES Downloader', createUI);
})();

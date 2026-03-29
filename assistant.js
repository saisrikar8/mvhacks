/**
 * Side-panel agent: OpenAI tool loop + local execution against window.__oceanRouteAssistant.
 * Dev server proxies /api/openai/chat (see vite.config.js); set OPENAI_API_KEY in .env
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

let domPurifyLinkHookAdded = false;
if (!domPurifyLinkHookAdded) {
    domPurifyLinkHookAdded = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A') {
            const href = node.getAttribute('href');
            if (href && /^https?:/i.test(href)) {
                node.setAttribute('target', '_blank');
                node.setAttribute('rel', 'noopener noreferrer');
            }
        }
    });
}

const MD_PURIFY = {
    ALLOWED_TAGS: [
        'p',
        'br',
        'strong',
        'em',
        'b',
        'i',
        'h1',
        'h2',
        'h3',
        'h4',
        'ul',
        'ol',
        'li',
        'blockquote',
        'code',
        'pre',
        'hr',
        'a',
        'del',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td'
    ],
    ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan']
};

function renderAssistantMarkdown(text) {
    const src = text == null ? '' : String(text);
    try {
        const raw = marked.parse(src, { async: false });
        return DOMPurify.sanitize(raw, MD_PURIFY);
    } catch {
        const d = document.createElement('div');
        d.textContent = src;
        return d.innerHTML;
    }
}

const API_URL = '/api/openai/chat';

const ASSISTANT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'plan_or_adapt_voyage',
            description:
                'Primary tool for planning a voyage or adapting to new constraints. Optionally replaces waypoints, updates shallow-water routing penalty (Voyage & vessel panel), then runs the full solver. Bathymetry map overlay is always on. The solver always computes three variants: distance (Fastest path), safety (Safest), time (Balanced). state.routeVariants has roughNm, maxWaveM, maxWindMs, maxCurrentMs, riskTier. Use intermediate waypoints for detours/via stops; use set_voyage_params for cruise speed, draft, or departure time.',
            parameters: {
                type: 'object',
                properties: {
                    waypoints: {
                        type: 'array',
                        description:
                            'Full ordered path [lng, lat][] from start to end. Omit to keep existing map waypoints.',
                        items: {
                            type: 'array',
                            items: { type: 'number' },
                            minItems: 2,
                            maxItems: 2
                        }
                    },
                    shallow_water_penalty: {
                        type: 'boolean',
                        description: 'Shallow-water routing penalty checkbox in Voyage & vessel.'
                    },
                    run_compute: {
                        type: 'boolean',
                        description: 'If false, only apply waypoints/options. Default true (run solver).'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_route_state',
            description:
                'Read current waypoints, computed route variants (if any), map view, and ocean UI toggles.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_waypoints',
            description:
                'Replace all waypoints with a new list (minimum start and end). Clears previous route lines.',
            parameters: {
                type: 'object',
                properties: {
                    points: {
                        type: 'array',
                        description: 'Ordered [lng, lat] pairs along the intended path.',
                        items: {
                            type: 'array',
                            items: { type: 'number' },
                            minItems: 2,
                            maxItems: 2
                        },
                        minItems: 2
                    }
                },
                required: ['points']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'undo_last_waypoint',
            description: 'Remove the last clicked waypoint.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'clear_route',
            description: 'Clear all waypoints and route overlays.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'compute_route',
            description:
                'Run the full ocean routing pipeline (same as Compute route). Computes all three variants: fastest (distance), safest (safety), balanced (time). Needs at least two waypoints. Prefer plan_or_adapt_voyage when also changing options or explaining a full plan.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'select_route_variant',
            description: 'Highlight a computed route variant on the map and in the dashboard.',
            parameters: {
                type: 'object',
                properties: {
                    variant: {
                        type: 'string',
                        enum: ['distance', 'safety', 'time'],
                        description: 'distance = fastest path, safety = weather/sea cautious, time = balanced'
                    }
                },
                required: ['variant']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'fly_map_to',
            description: 'Pan/zoom the map to a lng/lat.',
            parameters: {
                type: 'object',
                properties: {
                    lng: { type: 'number' },
                    lat: { type: 'number' },
                    zoom: { type: 'number', description: 'Optional zoom level.' }
                },
                required: ['lng', 'lat']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_ocean_options',
            description:
                'Toggle shallow-water routing penalty (Voyage & vessel). Bathymetry overlay cannot be turned off.',
            parameters: {
                type: 'object',
                properties: {
                    shallow_water_penalty: { type: 'boolean' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_voyage_params',
            description:
                'Set cruise speed (kn) for rough sea-time and ETA in the dashboard, optional declared draft (m), optional departure as ISO 8601 string for ETA, and/or shallow-water penalty. Recompute route if the user needs updated ETAs after changing speed or departure.',
            parameters: {
                type: 'object',
                properties: {
                    cruise_speed_kts: { type: 'number', description: 'Typical cruising speed in knots.' },
                    declared_draft_m: { type: 'number', description: 'Hull draft in meters (reference only).' },
                    departure_iso: {
                        type: 'string',
                        description: 'Planned departure instant, ISO 8601 (e.g. 2026-04-01T08:00:00-07:00).'
                    },
                    shallow_water_penalty: { type: 'boolean' }
                }
            }
        }
    }
];

function api() {
    return window.__oceanRouteAssistant;
}

async function executeTool(name, args) {
    const a = api();
    if (!a) return { ok: false, error: 'Assistant API not ready.' };
    try {
        switch (name) {
            case 'plan_or_adapt_voyage': {
                const wp = args?.waypoints;
                if (wp != null) {
                    if (!Array.isArray(wp) || wp.length < 2) {
                        return { ok: false, error: 'waypoints must include at least two [lng, lat] points when provided.' };
                    }
                    const setRes = a.setWaypointsFromCoords(wp);
                    if (!setRes.ok) return { ...setRes, phase: 'set_waypoints' };
                }
                if (args?.shallow_water_penalty != null) {
                    a.setOceanOptions({ shallowPenalty: args.shallow_water_penalty });
                }
                if (args?.run_compute === false) {
                    return {
                        ok: true,
                        computeSkipped: true,
                        state: a.getRouteAssistantSnapshot()
                    };
                }
                const computeResult = await a.runRouteComputation();
                const state = a.getRouteAssistantSnapshot();
                return {
                    ok: computeResult.ok,
                    compute: computeResult,
                    state,
                    explainVariants: `Three variants in state.routeVariants: id "distance" = Fastest path; "safety" = Safest; "time" = Balanced. Use label, roughNm, maxWaveM, maxWindMs, maxCurrentMs, riskTier for the user.`
                };
            }
            case 'get_route_state':
                return { ok: true, state: a.getRouteAssistantSnapshot() };
            case 'set_waypoints': {
                const pts = args?.points;
                return a.setWaypointsFromCoords(pts);
            }
            case 'undo_last_waypoint':
                a.undoLastPoint();
                return { ok: true };
            case 'clear_route':
                a.clearRouteOverlays();
                return { ok: true };
            case 'compute_route':
                return await a.runRouteComputation();
            case 'select_route_variant': {
                const v = args?.variant;
                if (!['distance', 'safety', 'time'].includes(v)) {
                    return { ok: false, error: 'Invalid variant.' };
                }
                a.selectRoute(v);
                return { ok: true, selected: v };
            }
            case 'fly_map_to':
                return a.flyTo(args.lng, args.lat, args.zoom);
            case 'set_ocean_options':
                return a.setOceanOptions({
                    shallowPenalty: args.shallow_water_penalty
                });
            case 'set_voyage_params':
                return a.setVoyageParams({
                    cruiseSpeedKts: args.cruise_speed_kts,
                    declaredDraftM: args.declared_draft_m,
                    departureISO: args.departure_iso,
                    shallowPenalty: args.shallow_water_penalty
                });
            default:
                return { ok: false, error: `Unknown tool: ${name}` };
        }
    } catch (e) {
        return { ok: false, error: String(e?.message || e) };
    }
}

const SYSTEM_PROMPT = `You are the in-app assistant for OceanRoute MVP: a Mapbox-based ocean voyage planner with weather-aware sea routing.

## Voyage planning (required behavior)
When the user asks to plan a voyage, plot a route, sail from A to B, or similar: resolve places to [longitude, latitude] when you know them; otherwise ask for coordinates or have them click the map first. Then call **plan_or_adapt_voyage** (with waypoints if you have them, or omit waypoints if the user already placed points). After a successful compute, your **next message must** explain all three paths together, clearly labeled:
1. **Fastest (distance)** — id \`distance\`; shortest-style offshore track in the solver.
2. **Safest (safety)** — id \`safety\`; favors calmer sea state (waves, wind, current) where the grid allows.
3. **Balanced (time)** — id \`time\`; compromise between track length and conditions.

For each variant, use numbers from \`state.routeVariants\`: roughNm (approximate nautical miles), maxWaveM, maxWindMs, maxCurrentMs, riskTier (LOW / MODERATE / ELEVATED / HIGH). Say which option fits cautious vs fast passages. Note data is model/forecast approximations, not for sole navigation decisions.

## Adapting to constraints
When the user adds constraints (avoid shallow water, prefer safer seas, stopovers, detours): use **get_route_state**, then **plan_or_adapt_voyage** with updated **waypoints** and/or **shallow_water_penalty**. Bathymetry is always shown on the map. For cruise speed, draft, or departure time for ETAs, use **set_voyage_params** (user can also edit the Voyage & vessel panel); after changing speed or departure, offer to **compute_route** again so the dashboard refreshes time estimates.

## General rules
- Use tools for map changes, waypoints, options, or routing — do not only describe UI clicks.
- Coordinates are always [longitude, latitude] in WGS84.
- After compute errors, read \`hint\` or \`error\` from tool results and suggest zoom/pan or more waypoints.
- Be concise but complete on the three-variant summary when planning.

## Reply format
Write every user-facing answer in **GitHub-flavored Markdown**: use \`###\` headings, **bold** for emphasis, bullet/numbered lists, and backticks for coordinates, variant ids, and numbers. Short tables are fine when comparing the three routes.`;

async function callOpenAI(messages) {
    const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages,
            tools: ASSISTANT_TOOLS,
            tool_choice: 'auto'
        })
    });
    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(text || `HTTP ${res.status}`);
    }
    if (!res.ok) {
        const msg = data?.error?.message || data?.error || text;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data;
}

const MAX_AGENT_STEPS = 22;

async function runAgentTurn(userText, messages, onTool) {
    messages.push({ role: 'user', content: userText });

    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
        const data = await callOpenAI(messages);
        const choice = data.choices?.[0];
        const msg = choice?.message;
        if (!msg) break;

        messages.push(msg);

        if (msg.tool_calls?.length) {
            for (const tc of msg.tool_calls) {
                const fn = tc.function;
                let args = {};
                try {
                    args = fn.arguments ? JSON.parse(fn.arguments) : {};
                } catch {
                    args = {};
                }
                onTool?.(fn.name, args);
                const result = await executeTool(fn.name, args);
                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify(result)
                });
            }
            continue;
        }

        const content = msg.content?.trim();
        if (content) return content;
        break;
    }
    return 'No response from the model.';
}

function scrollMessagesToBottom(messagesEl) {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        });
    });
}

export function initRouteAssistant() {
    const root = document.getElementById('ai-assistant');
    const messagesEl = document.getElementById('ai-assistant-messages');
    const form = document.getElementById('ai-assistant-form');
    const input = document.getElementById('ai-assistant-input');
    const sendBtn = document.getElementById('ai-assistant-send');
    const statusEl = document.getElementById('ai-assistant-status');
    const toggleBtn = document.getElementById('ai-assistant-toggle');

    if (!root || !messagesEl || !form || !input) return;

    /** @type {Array<{role: string, content?: string, tool_calls?: unknown, tool_call_id?: string}>} */
    const transcript = [{ role: 'system', content: SYSTEM_PROMPT }];

    function appendBubble(text, role) {
        const div = document.createElement('div');
        div.className = `ai-msg ai-msg-${role}`;
        if (role === 'assistant') {
            div.classList.add('ai-msg-md');
            div.innerHTML = renderAssistantMarkdown(text);
        } else {
            div.textContent = text;
        }
        messagesEl.appendChild(div);
        scrollMessagesToBottom(messagesEl);
    }

    function setBusy(b) {
        input.disabled = b;
        sendBtn.disabled = b;
        statusEl.textContent = b ? 'Thinking…' : '';
        statusEl.style.display = b ? 'block' : 'none';
    }

    let collapsed = false;
    toggleBtn?.addEventListener('click', () => {
        collapsed = !collapsed;
        root.classList.toggle('ai-collapsed', collapsed);
        toggleBtn.setAttribute('aria-expanded', String(!collapsed));
        toggleBtn.textContent = collapsed ? '▶' : '◀';
        toggleBtn.title = collapsed ? 'Expand assistant' : 'Collapse assistant';
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        appendBubble(text, 'user');
        setBusy(true);
        try {
            const reply = await runAgentTurn(text, transcript, (name) => {
                appendBubble(`→ ${name}`, 'tool');
            });
            appendBubble(reply, 'assistant');
        } catch (err) {
            appendBubble(`Error: ${err.message}`, 'assistant');
        } finally {
            setBusy(false);
        }
    });
}

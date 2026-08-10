import * as vscode from "vscode";
import {
  PRESETS,
  SECTION,
  SETTING_GROUPS,
  SettingSpec,
  SettingValue,
  allSettings,
  findSetting,
} from "../settingsSchema";
import { write } from "../settings";

/** The live facts shown at the top of the panel, supplied by the extension. */
export interface PanelStatus {
  hooks: "ok" | "missing" | "stale" | "foreign";
  hooksEnabled: boolean;
  transcriptEnabled: boolean;
  pendingFiles: number;
  pendingChanges: number;
  unreviewable: number;
}

type Scope = "user" | "workspace";

const SCOPE_KEY = "settingsPanelScope";

/**
 * One page that explains every surface this extension can draw and lets the
 * user turn each of them on or off — plus three presets that set the whole
 * group coherently.
 *
 * It writes ordinary VS Code settings, so nothing here is a private store: the
 * same values are visible in the Settings editor, can be set per project, and
 * travel with Settings Sync. The panel exists because a flat list of nineteen
 * keys cannot say *what a surface costs you*, and that is the only question
 * worth answering when choosing between them.
 */
export class SettingsPanel {
  private static current: SettingsPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private scope: Scope;

  static show(
    context: vscode.ExtensionContext,
    status: () => PanelStatus,
    onDidChangeStatus: vscode.Event<unknown>
  ): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "claudeKeepUndo.settings",
      "Claude Keep/Undo: Settings",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false }
    );
    SettingsPanel.current = new SettingsPanel(
      panel,
      context,
      status,
      onDidChangeStatus
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly status: () => PanelStatus,
    onDidChangeStatus: vscode.Event<unknown>
  ) {
    this.scope = context.workspaceState.get<Scope>(SCOPE_KEY) ?? "user";
    panel.webview.html = this.html();

    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg) => void this.handle(msg)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) {
          this.post();
        }
      }),
      onDidChangeStatus(() => this.post())
    );
    panel.onDidDispose(() => this.dispose());
  }

  private dispose(): void {
    SettingsPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.panel.dispose();
  }

  private target(): vscode.ConfigurationTarget {
    return this.scope === "workspace"
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  }

  /** The effective value of every setting, and where it is coming from. */
  private values(): Record<string, { value: SettingValue; source: string }> {
    const config = vscode.workspace.getConfiguration(SECTION);
    const out: Record<string, { value: SettingValue; source: string }> = {};
    for (const spec of allSettings()) {
      const info = config.inspect(spec.key);
      const source =
        info?.workspaceFolderValue !== undefined
          ? "folder"
          : info?.workspaceValue !== undefined
            ? "workspace"
            : info?.globalValue !== undefined
              ? "user"
              : "default";
      out[spec.key] = {
        value: config.get<SettingValue>(spec.key, spec.default),
        source,
      };
    }
    return out;
  }

  private post(): void {
    void this.panel.webview.postMessage({
      type: "state",
      values: this.values(),
      status: this.status(),
      scope: this.scope,
    });
  }

  private async handle(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }
    const msg = message as Record<string, unknown>;
    switch (msg.type) {
      case "ready":
        this.post();
        return;
      case "scope": {
        this.scope = msg.value === "workspace" ? "workspace" : "user";
        await this.context.workspaceState.update(SCOPE_KEY, this.scope);
        this.post();
        return;
      }
      case "set": {
        const key = typeof msg.key === "string" ? msg.key : undefined;
        const spec = key ? findSetting(key) : undefined;
        if (!spec || !isValid(spec, msg.value)) {
          return;
        }
        await write(spec.key, msg.value as SettingValue, this.target());
        this.post();
        return;
      }
      case "preset": {
        const preset = PRESETS.find((p) => p.id === msg.id);
        if (!preset) {
          return;
        }
        for (const [key, value] of Object.entries(preset.values)) {
          await write(key, value, this.target());
        }
        this.post();
        return;
      }
      case "reset": {
        // Clearing the keys rather than writing the defaults back: a setting the
        // user never touched should stay untouched in their settings.json.
        for (const spec of allSettings()) {
          await write(spec.key, undefined, this.target());
        }
        this.post();
        return;
      }
      case "openNativeSettings":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          `@ext:FedeFluork.claude-keep-undo`
        );
        return;
      case "run": {
        const allowed = new Set([
          "claudeKeepUndo.installHooks",
          "claudeKeepUndo.openAllChanges",
          "claudeKeepUndo.revealSnapshots",
          "claudeKeepUndo.openWalkthrough",
          "claudeKeepUndo.refresh",
        ]);
        if (typeof msg.command === "string" && allowed.has(msg.command)) {
          await vscode.commands.executeCommand(msg.command);
        }
        return;
      }
    }
  }

  private html(): string {
    const nonce = makeNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Keep/Undo: Settings</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <h1>Keep / Undo for Claude Code</h1>
    <p class="lede">Every surface this extension can put on your screen, what it
    costs you, and how to turn it off. These are ordinary VS Code settings — the
    Settings editor shows the same values.</p>
    <div id="status" class="chips"></div>
  </header>

  <section class="scope">
    <span class="scope-label">Apply changes to</span>
    <label><input type="radio" name="scope" value="user"> All projects (User)</label>
    <label><input type="radio" name="scope" value="workspace"> This workspace only</label>
  </section>

  <section class="presets">
    <h2>Presets</h2>
    <p class="blurb">A coherent set of surfaces in one click. Detection and safety
    settings are never touched by a preset.</p>
    <div class="preset-grid">
      ${PRESETS.map(
        (p) => `<button class="preset" data-preset="${esc(p.id)}">
          <span class="preset-name">${esc(p.label)}</span>
          <span class="preset-blurb">${esc(p.blurb)}</span>
        </button>`
      ).join("")}
    </div>
  </section>

  ${SETTING_GROUPS.map(
    (group) => `<section class="group">
    <h2>${esc(group.title)}</h2>
    <p class="blurb">${esc(group.blurb)}</p>
    ${group.settings.map((spec) => control(spec)).join("")}
  </section>`
  ).join("")}

  <footer>
    <button class="link" data-action="openNativeSettings">Open in the Settings editor</button>
    <button class="link" data-run="claudeKeepUndo.openWalkthrough">Getting started</button>
    <button class="link" data-run="claudeKeepUndo.revealSnapshots">Recovery snapshots</button>
    <button class="link danger" data-action="reset">Reset everything to defaults</button>
  </footer>
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
  }
}

/** One rendered setting: title, explanation, and the control itself. */
function control(spec: SettingSpec): string {
  const id = `s-${spec.key.replace(/\./g, "-")}`;
  let body: string;
  if (spec.type === "enum") {
    body = `<div class="choices">${(spec.choices ?? [])
      .map(
        (c, i) => `<label class="choice">
        <input type="radio" name="${esc(id)}" data-key="${esc(
          spec.key
        )}" value="${esc(c.value)}" id="${esc(id)}-${i}">
        <span><span class="choice-label">${esc(
          c.label
        )}</span><span class="choice-detail">${esc(c.detail)}</span></span>
      </label>`
      )
      .join("")}</div>`;
  } else if (spec.type === "boolean") {
    body = `<label class="toggle">
      <input type="checkbox" data-key="${esc(spec.key)}">
      <span>Enabled</span>
    </label>`;
  } else {
    body = `<input class="text" type="text" data-key="${esc(
      spec.key
    )}" maxlength="${spec.maxLength ?? 32}">`;
  }
  return `<div class="setting" data-setting="${esc(spec.key)}">
    <div class="setting-head">
      <h3>${esc(spec.title)}</h3>
      <span class="source" data-source-for="${esc(spec.key)}"></span>
    </div>
    <p class="detail">${esc(spec.detail)}</p>
    ${body}
    ${spec.note ? `<p class="note">${esc(spec.note)}</p>` : ""}
    <p class="key"><code>${SECTION}.${esc(spec.key)}</code></p>
  </div>`;
}

function isValid(spec: SettingSpec, value: unknown): boolean {
  if (spec.type === "boolean") {
    return typeof value === "boolean";
  }
  if (spec.type === "string") {
    return typeof value === "string" && value.length <= (spec.maxLength ?? 32);
  }
  return (
    typeof value === "string" &&
    (spec.choices ?? []).some((c) => c.value === value)
  );
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function makeNonce(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  line-height: 1.5;
}
main { max-width: 780px; margin: 0 auto; padding: 28px 24px 64px; }
h1 { font-size: 1.5rem; margin: 0 0 6px; font-weight: 600; }
h2 { font-size: 1.05rem; margin: 0 0 4px; font-weight: 600; }
h3 { font-size: 0.95rem; margin: 0; font-weight: 600; }
p { margin: 0 0 10px; }
.lede { color: var(--vscode-descriptionForeground); max-width: 62ch; }
.blurb { color: var(--vscode-descriptionForeground); max-width: 68ch; margin-bottom: 16px; }
.detail { color: var(--vscode-descriptionForeground); margin: 4px 0 10px; max-width: 68ch; }
header { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 18px; margin-bottom: 18px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: 999px; font-size: 0.85em;
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editorWidget-background);
}
.chip.ok { border-color: var(--vscode-charts-green); }
.chip.warn { border-color: var(--vscode-charts-yellow); }
.chip button {
  background: none; border: none; padding: 0; margin-left: 2px;
  color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit;
  text-decoration: underline;
}
.scope {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  padding: 10px 14px; margin-bottom: 26px; border-radius: 6px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-panel-border);
}
.scope-label { color: var(--vscode-descriptionForeground); }
.scope label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
section { margin-bottom: 34px; }
.preset-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.preset {
  display: flex; flex-direction: column; gap: 4px; text-align: left;
  padding: 12px 14px; border-radius: 6px; cursor: pointer; font: inherit;
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editorWidget-background);
  color: var(--vscode-foreground);
}
.preset:hover { border-color: var(--vscode-focusBorder); }
.preset-name { font-weight: 600; }
.preset-blurb { color: var(--vscode-descriptionForeground); font-size: 0.88em; }
.setting {
  padding: 14px 16px; margin-bottom: 12px; border-radius: 6px;
  border: 1px solid var(--vscode-panel-border);
}
.setting-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.source { font-size: 0.8em; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.source.set { color: var(--vscode-textLink-foreground); }
.choices { display: flex; flex-direction: column; gap: 8px; }
.choice { display: flex; gap: 9px; align-items: flex-start; cursor: pointer; }
.choice input { margin-top: 4px; flex: none; }
.choice-label { display: block; }
.choice-detail { display: block; color: var(--vscode-descriptionForeground); font-size: 0.88em; }
.toggle { display: inline-flex; gap: 8px; align-items: center; cursor: pointer; }
.text {
  padding: 4px 8px; border-radius: 3px; font: inherit; width: 10ch;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
}
.note {
  margin: 10px 0 0; padding-left: 10px; font-size: 0.88em;
  border-left: 2px solid var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
}
.key { margin: 10px 0 0; font-size: 0.82em; color: var(--vscode-descriptionForeground); }
code { font-family: var(--vscode-editor-font-family); }
footer { display: flex; flex-wrap: wrap; gap: 18px; border-top: 1px solid var(--vscode-panel-border); padding-top: 18px; }
button.link {
  background: none; border: none; padding: 0; font: inherit; cursor: pointer;
  color: var(--vscode-textLink-foreground); text-decoration: underline;
}
button.link.danger { color: var(--vscode-errorForeground); }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();

document.addEventListener('change', (event) => {
  const el = event.target;
  if (el.name === 'scope') {
    vscode.postMessage({ type: 'scope', value: el.value });
    return;
  }
  const key = el.dataset && el.dataset.key;
  if (!key) { return; }
  if (el.type === 'checkbox') {
    vscode.postMessage({ type: 'set', key, value: el.checked });
  } else if (el.type === 'radio') {
    vscode.postMessage({ type: 'set', key, value: el.value });
  } else {
    vscode.postMessage({ type: 'set', key, value: el.value });
  }
});

document.addEventListener('click', (event) => {
  const preset = event.target.closest('[data-preset]');
  if (preset) { vscode.postMessage({ type: 'preset', id: preset.dataset.preset }); return; }
  const run = event.target.closest('[data-run]');
  if (run) { vscode.postMessage({ type: 'run', command: run.dataset.run }); return; }
  const action = event.target.closest('[data-action]');
  if (!action) { return; }
  if (action.dataset.action === 'reset') { vscode.postMessage({ type: 'reset' }); }
  if (action.dataset.action === 'openNativeSettings') { vscode.postMessage({ type: 'openNativeSettings' }); }
});

const SOURCE_TEXT = {
  default: 'default',
  user: 'set for all projects',
  workspace: 'set in this workspace',
  folder: 'set for this folder'
};

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'state') { return; }

  for (const input of document.querySelectorAll('input[name="scope"]')) {
    input.checked = input.value === msg.scope;
  }

  for (const [key, info] of Object.entries(msg.values)) {
    // The keys come from our own schema — letters and dots — so they need no
    // escaping here, and CSS.escape would be the wrong tool anyway: it escapes
    // identifiers, not the inside of a quoted attribute value.
    for (const input of document.querySelectorAll('[data-key="' + key + '"]')) {
      if (input.type === 'checkbox') { input.checked = info.value === true; }
      else if (input.type === 'radio') { input.checked = input.value === info.value; }
      else if (document.activeElement !== input) { input.value = info.value; }
    }
    const label = document.querySelector('[data-source-for="' + key + '"]');
    if (label) {
      label.textContent = SOURCE_TEXT[info.source] || info.source;
      label.classList.toggle('set', info.source !== 'default');
    }
  }

  renderStatus(msg.status);
});

function chip(cls, text, action, actionLabel) {
  const el = document.createElement('span');
  el.className = 'chip ' + cls;
  el.appendChild(document.createTextNode(text));
  if (action) {
    const button = document.createElement('button');
    button.textContent = actionLabel;
    button.dataset.run = action;
    el.appendChild(button);
  }
  return el;
}

function renderStatus(status) {
  const host = document.getElementById('status');
  host.textContent = '';
  if (!status.hooksEnabled) {
    host.appendChild(chip('warn', 'Hook detection turned off'));
  } else if (status.hooks === 'ok') {
    host.appendChild(chip('ok', 'Hooks installed — exact baselines'));
  } else if (status.hooks === 'foreign') {
    host.appendChild(chip('warn', 'A hook that is not ours is registered'));
  } else {
    host.appendChild(chip('warn', 'Hooks not installed', 'claudeKeepUndo.installHooks', 'Install'));
  }
  host.appendChild(chip(
    status.transcriptEnabled ? 'ok' : '',
    status.transcriptEnabled ? 'Transcript reader on' : 'Transcript reader off'
  ));
  host.appendChild(
    status.pendingFiles > 0
      ? chip('', status.pendingFiles + (status.pendingFiles === 1 ? ' file' : ' files') +
          ' awaiting review (' + status.pendingChanges +
          (status.pendingChanges === 1 ? ' change' : ' changes') + ')',
          'claudeKeepUndo.openAllChanges', 'Review')
      : chip('', 'Nothing awaiting review')
  );
  if (status.unreviewable > 0) {
    host.appendChild(chip('warn', status.unreviewable + ' not reviewable'));
  }
}

vscode.postMessage({ type: 'ready' });
`;

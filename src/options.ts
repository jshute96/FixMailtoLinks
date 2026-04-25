// Options page script: loads config from synced storage, lets the
// user edit the URL template, and saves it back.

import { DEFAULT_CONFIG, loadConfig, saveConfig } from './config.js';

const input = document.getElementById('urlTemplate') as HTMLInputElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLSpanElement;

function flashStatus(msg: string): void {
  status.textContent = msg;
  setTimeout(() => {
    if (status.textContent === msg) status.textContent = '';
  }, 1500);
}

async function init(): Promise<void> {
  const cfg = await loadConfig();
  input.value = cfg.urlTemplate;
}

saveBtn.addEventListener('click', async () => {
  await saveConfig({ urlTemplate: input.value });
  flashStatus('Saved.');
});

resetBtn.addEventListener('click', async () => {
  input.value = DEFAULT_CONFIG.urlTemplate;
  await saveConfig({ ...DEFAULT_CONFIG });
  flashStatus('Reset.');
});

void init();

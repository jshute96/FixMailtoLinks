// Options page script: loads config from synced storage, lets the
// user edit the URL template, and saves it back.

import {
  DEFAULT_CONFIG,
  isValidTemplate,
  loadConfig,
  saveConfig,
} from './config.js';

const input = document.getElementById('urlTemplate') as HTMLInputElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLSpanElement;

function flashStatus(msg: string, isError = false): void {
  status.textContent = msg;
  status.classList.toggle('error', isError);
  setTimeout(() => {
    if (status.textContent === msg) {
      status.textContent = '';
      status.classList.remove('error');
    }
  }, 1500);
}

async function init(): Promise<void> {
  const cfg = await loadConfig();
  input.value = cfg.urlTemplate;
}

async function save(): Promise<void> {
  // Reject rather than silently substituting the default: a template
  // that can't work (empty, or a non-http scheme) is almost always a
  // typo, and quietly discarding what the user typed is worse than
  // telling them. See isValidTemplate() for why the scheme matters.
  const template = input.value.trim();
  if (!isValidTemplate(template)) {
    flashStatus('Enter a URL starting with http:// or https://', true);
    return;
  }
  input.value = template;
  await saveConfig({ urlTemplate: template });
  flashStatus('Saved.');
}

saveBtn.addEventListener('click', () => void save());

// The input isn't in a <form>, so wire up Enter by hand — typing a
// template and hitting Enter is the obvious thing to try.
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void save();
});

resetBtn.addEventListener('click', async () => {
  input.value = DEFAULT_CONFIG.urlTemplate;
  await saveConfig({ ...DEFAULT_CONFIG });
  flashStatus('Reset.');
});

void init();

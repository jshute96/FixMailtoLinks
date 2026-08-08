// Options page script: edits the ordered list of link targets, saves it
// to synced storage, and runs a live "Test it" link against whatever is
// currently in the form.
//
// This is the one file in src/ that is an ES module. It has no imports:
// `config.js` and `dialog.js` are loaded ahead of it as classic scripts
// (see options.html) so the content script can share them, which makes
// everything they declare a global here.

const list = document.getElementById('targets') as HTMLDivElement;
const rowTemplate = document.getElementById('rowTemplate') as HTMLTemplateElement;
const noTargets = document.getElementById('noTargets') as HTMLParagraphElement;
const addBtn = document.getElementById('add') as HTMLButtonElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
// One per line in the "Test it" section. Two lines by default, so a
// config with per-domain rules can be tried against addresses that match
// differently without retyping.
const testRows = Array.from(
  document.querySelectorAll<HTMLElement>('.testrow'),
);

const TEMPLATE_ERROR =
  'Link targets must be URLs starting with http:// or https://';

const PLACEHOLDER_ERROR =
  'Link targets must include {username} or {email}';

// Confirmations fade on their own; errors stay put until the user does
// something about them. A message you have to catch within a couple of
// seconds is no use when it's telling you the save didn't happen.
function showStatus(msg: string, isError = false): void {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
  if (isError) return;
  setTimeout(() => {
    if (statusEl.textContent === msg) clearStatus();
  }, 2500);
}

function clearStatus(): void {
  statusEl.textContent = '';
  statusEl.classList.remove('error');
}

function rows(): HTMLElement[] {
  return Array.from(list.children) as HTMLElement[];
}

function field(row: HTMLElement, selector: string): HTMLInputElement {
  return row.querySelector(selector) as HTMLInputElement;
}

function addRow(target: TargetConfig): HTMLElement {
  const row = (rowTemplate.content.cloneNode(true) as DocumentFragment)
    .firstElementChild as HTMLElement;
  field(row, '.domain').value = target.emailDomain;
  field(row, '.template').value = target.urlTemplate;
  field(row, '.auto input').checked = target.openDirectly;
  list.appendChild(row);
  refreshList();
  return row;
}

// Run after anything that adds, removes, or reorders rows.
function refreshList(): void {
  // An empty list is legitimate (it means "always ask"), so say so
  // rather than leaving a blank gap that looks broken.
  const all = rows();
  noTargets.hidden = all.length > 0;
  // A row can't move past the end of the list, so don't offer to.
  all.forEach((row, i) => {
    (row.querySelector('.up') as HTMLButtonElement).disabled = i === 0;
    (row.querySelector('.down') as HTMLButtonElement).disabled =
      i === all.length - 1;
  });
}

function renderConfig(cfg: Config): void {
  list.textContent = '';
  for (const target of cfg.targets) addRow(target);
  refreshList();
}

// Reads the form as-is. Values are untrimmed and may be invalid; callers
// either validate (save) or normalize away the bad rows (test).
function readForm(): Config {
  return {
    targets: rows().map((row) => ({
      emailDomain: field(row, '.domain').value,
      urlTemplate: field(row, '.template').value,
      openDirectly: field(row, '.auto input').checked,
    })),
  };
}

async function save(): Promise<void> {
  // Reject rather than silently dropping a row: a template that can't
  // work is almost always a typo, and quietly discarding what the user
  // typed is worse than telling them. See isValidTemplate() for why the
  // scheme matters.
  for (const row of rows()) {
    const input = field(row, '.template');
    if (!isValidTemplate(input.value)) {
      showStatus(TEMPLATE_ERROR, true);
      input.focus();
      return;
    }
    if (!templateUsesAddress(input.value)) {
      showStatus(PLACEHOLDER_ERROR, true);
      input.focus();
      return;
    }
  }
  const cfg = normalizeConfig(readForm());
  await saveConfig(cfg);
  // Re-render so the trimmed/lower-cased values the user actually saved
  // are what they see.
  renderConfig(cfg);
  showStatus('Saved.');
}

// Any edit is an attempt to fix whatever the error complained about, so
// stop showing it.
list.addEventListener('input', clearStatus);

list.addEventListener('click', (e) => {
  const button = (e.target as Element).closest('button');
  if (!button) return;
  const row = button.closest('.grid') as HTMLElement | null;
  if (!row) return;
  if (button.classList.contains('remove')) {
    row.remove();
  } else if (button.classList.contains('up')) {
    row.previousElementSibling?.before(row);
  } else if (button.classList.contains('down')) {
    row.nextElementSibling?.after(row);
  }
  refreshList();
});

addBtn.addEventListener('click', () => {
  clearStatus();
  const row = addRow({
    emailDomain: '',
    urlTemplate: '',
    openDirectly: false,
  });
  field(row, '.domain').focus();
});

saveBtn.addEventListener('click', () => void save());

cancelBtn.addEventListener('click', () => {
  void loadConfig().then((cfg) => {
    renderConfig(cfg);
    showStatus('Changes discarded.');
  });
});

function testInput(row: HTMLElement): HTMLInputElement {
  return row.querySelector('.testEmail') as HTMLInputElement;
}

function testAnchor(row: HTMLElement): HTMLAnchorElement {
  return row.querySelector('.testLink') as HTMLAnchorElement;
}

function syncTestLink(row: HTMLElement): void {
  const input = testInput(row);
  // Falling back to the line's own default keeps the link usable while
  // the field is empty mid-edit.
  const address = input.value.trim() || input.dataset.default || '';
  const href = `mailto:${address}`;
  const link = testAnchor(row);
  link.href = href;
  link.textContent = href;
}

function runTest(row: HTMLElement): void {
  const link = testAnchor(row);
  const email = emailFromMailto(link.getAttribute('href') ?? '');
  if (!email) return;
  // Deliberately the *live* form, not storage, so you can try a target
  // out before committing to it. Invalid rows normalize away.
  const cfg = normalizeConfig(readForm());
  const href = desiredHref(cfg, email);
  if (href !== null) {
    window.open(href, '_blank', 'noopener');
    return;
  }
  showMailtoDialog({
    doc: document,
    email,
    mailtoHref: link.getAttribute('href') ?? '',
    targets: matchingTargets(cfg, email),
    // A new tab keeps the unsaved form this test is running against.
    openInNewTab: true,
    // No onConfigure: closing the dialog already puts the user back on
    // the settings, which is where that button would send them.
  });
}

for (const row of testRows) {
  testInput(row).addEventListener('input', () => syncTestLink(row));
  testAnchor(row).addEventListener('click', (e) => {
    e.preventDefault();
    runTest(row);
  });
}

async function init(): Promise<void> {
  for (const row of testRows) syncTestLink(row);
  renderConfig(await loadConfig());
  // The initial render waits on storage, so tests (and anything else
  // driving this page) need a way to know the form is populated.
  document.body.dataset.ready = 'true';
}

void init();

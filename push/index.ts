//@ts-nocheck
// Dependencies
// NPM: web-push
// NPM: enquirer
// NPM: fs-extra
// NPM: mime-types
// NPM: picocolors
// NPM: figlet

import fs from 'fs-extra';
import { spawn } from 'child_process';
import { lookup as mimeLookup } from 'mime-types';
import pc from 'picocolors';
import * as figlet from 'figlet';
import * as webPush from 'web-push';
const { prompt } = require('enquirer');

// Types

type Urgency = 'very-low' | 'low' | 'normal' | 'high';

interface PushKeys {
  auth: string;
  p256dh: string;
}

interface SubscriptionLike {
  endpoint: string;
  keys: PushKeys;
}

interface NotificationAction {
  action: string;
  title: string;
  icon?: string;
}

interface NotificationPayload {
  title: string;
  body?: string;
  icon?: string;
  image?: string;
  badge?: string;
  vibrate?: number[];
  actions?: NotificationAction[];
  data?: any;
  tag?: string;
  renotify?: boolean;
  requireInteraction?: boolean;
  silent?: boolean;
  timestamp?: number;
  dir?: 'auto' | 'ltr' | 'rtl';
  lang?: string;
}

interface SendOptions {
  TTL?: number;
  urgency?: Urgency;
  topic?: string;
}

// UI helpers
function header(): void {
  const title = figlet.textSync('Push CLI', { horizontalLayout: 'fitted' });
  const line = '='.repeat(60);
  console.log(pc.cyan(line));
  console.log(pc.cyan(title));
  console.log(pc.cyan(line));
  console.log(pc.dim('Build and send a Web Push payload with a friendly TUI.'));
  console.log('');
}

function usage(exit = false): void {
  console.log(`Usage: ${pc.bold('ts-node push.ts')} <endpoint> <auth> <p256dh> [--help]\n`);
  console.log(`Example endpoint: ${pc.cyan('https://fcm.googleapis.com/fcm/send/...')}`);
  if (exit) process.exit(1);
}

function isBase64Url(str: string): boolean {
  return /^[A-Za-z0-9_\-]+$/.test(str);
}

function validateArgs(endpoint?: string, auth?: string, p256dh?: string): string[] {
  const errs: string[] = [];
  if (!endpoint || !endpoint.startsWith('https://')) errs.push('A valid HTTPS endpoint is required.');
  if (!auth || !isBase64Url(auth)) errs.push('Auth must be a base64url string.');
  if (!p256dh || !isBase64Url(p256dh)) errs.push('p256dh must be a base64url string.');
  return errs;
}

async function pickFileViaWindowsExplorer(title = 'Select an image'): Promise<string | null> {
  return new Promise((resolve) => {
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = '${title.replace(/'/g, "''")}'
$dlg.Filter = 'Images|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp|All files|*.*'
$dlg.CheckFileExists = $true
$dlg.Multiselect = $false
[void]$dlg.ShowDialog()
if ($dlg.FileName) { [Console]::Out.Write($dlg.FileName) }
`;
    const ps = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript], {
      windowsHide: true,
    });
    let stdout = '';
    ps.stdout.on('data', (d) => (stdout += d.toString()));
    ps.on('close', () => resolve(stdout.trim() || null));
    ps.on('error', () => resolve(null));
  });
}

async function fileToDataUrl(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  const mime = (mimeLookup(filePath) as string) || 'application/octet-stream';
  const b64 = buf.toString('base64');
  return `data:${mime};base64,${b64}`;
}

async function askCredentials(): Promise<
  | { mode: 'vapid'; subject: string; publicKey: string; privateKey: string }
  | { mode: 'fcm'; serverKey: string }
> {
  const { mode } = await prompt<{ mode: 'vapid' | 'fcm' }>([
    {
      type: 'select',
      name: 'mode',
      message: 'Choose send auth mode',
      choices: [
        { name: 'vapid', message: 'VAPID (recommended)' },
        { name: 'fcm', message: 'FCM Legacy Server Key (deprecated)' },
      ],
      initial: 0,
    },
  ]);

  if (mode === 'vapid') {
    const cred = await prompt<{ subject: string; publicKey: string; privateKey: string; }>([
      {
        type: 'input',
        name: 'subject',
        message: 'Subject (e.g., mailto:you@example.com or https://yoursite.com/)',
        initial: 'https://tiny.one/saygoodbye',
      },
      { type: 'input', name: 'publicKey', message: 'VAPID Public Key (must match the client subscription key)' },
      { type: 'password', name: 'privateKey', message: 'VAPID Private Key' },
    ]);
    return { mode: 'vapid', subject: cred.subject, publicKey: cred.publicKey, privateKey: cred.privateKey };
  }

  const { serverKey } = await prompt<{ serverKey: string }>([
    { type: 'password', name: 'serverKey', message: 'FCM Legacy Server Key' },
  ]);
  return { mode: 'fcm', serverKey };
}

async function askNotificationPayload(): Promise<{ payload: NotificationPayload; sendOptions: SendOptions }> {
  // Base fields first
  const base = await prompt<{
    title: string;
    body?: string;
    addIcon: boolean;
    addImage: boolean;
    addBadge: boolean;
  }>([
    { type: 'input', name: 'title', message: 'Title', initial: 'Hello from Push CLI' },
    { type: 'input', name: 'body', message: 'Body', initial: 'This is a test notification.' },
    { type: 'confirm', name: 'addIcon', message: 'Add icon?', initial: false },
    { type: 'confirm', name: 'addImage', message: 'Add image?', initial: true },
    { type: 'confirm', name: 'addBadge', message: 'Add badge URL?', initial: false },
  ]);

  // Icon flow
  let icon: string | undefined;
  if (base.addIcon) {
    const { iconSrc } = await prompt<{ iconSrc: 'url' | 'file' | 'path' }>([
      { type: 'select', name: 'iconSrc', message: 'Icon source', choices: ['url', 'file', 'path'], initial: 0 },
    ]);
    if (iconSrc === 'url') {
      const { iconUrl } = await prompt<{ iconUrl: string }>([
        { type: 'input', name: 'iconUrl', message: 'Icon URL' },
      ]);
      icon = iconUrl || undefined;
    } else if (iconSrc === 'path') {
      const { iconPath } = await prompt<{ iconPath: string }>([
        { type: 'input', name: 'iconPath', message: 'Icon file path' },
      ]);
      if (iconPath) {
        try {
          const exists = await fs.pathExists(iconPath);
          if (exists) {
            icon = await fileToDataUrl(iconPath);
            console.log(pc.dim(`Embedded icon from path: ${iconPath}`));
          } else {
            console.log(pc.yellow('Icon path not found; ignoring.'));
          }
        } catch (e) {
          console.log(pc.yellow(`Failed to read icon path: ${String(e)}`));
        }
      }
    } else if (iconSrc === 'file') {
      console.log(pc.dim('Opening icon picker...'));
      const pickedIcon = await pickFileViaWindowsExplorer('Select an icon to embed');
      if (pickedIcon) {
        icon = await fileToDataUrl(pickedIcon);
        console.log(pc.dim(`Embedded icon from file: ${pickedIcon}`));
      } else {
        console.log(pc.yellow('No icon selected.'));
        const { wantPath } = await prompt<{ wantPath: boolean }>([
          { type: 'confirm', name: 'wantPath', message: 'Enter an icon file path instead?', initial: false },
        ]);
        if (wantPath) {
          const { iconPathManual } = await prompt<{ iconPathManual: string }>([
            { type: 'input', name: 'iconPathManual', message: 'Icon file path' },
          ]);
          try {
            const exists = await fs.pathExists(iconPathManual);
            if (exists) {
              icon = await fileToDataUrl(iconPathManual);
              console.log(pc.dim(`Embedded icon from path: ${iconPathManual}`));
            } else {
              console.log(pc.yellow('Icon path not found; ignoring.'));
            }
          } catch (e) {
            console.log(pc.yellow(`Failed to read icon path: ${String(e)}`));
          }
        }
      }
    }
  }

  // Image flow
  let image: string | undefined;
  if (base.addImage) {
    const { imageSrc } = await prompt<{ imageSrc: 'url' | 'file' | 'path' }>([
      { type: 'select', name: 'imageSrc', message: 'Image source', choices: ['url', 'file', 'path'], initial: 1 },
    ]);
    if (imageSrc === 'url') {
      const { imageUrl } = await prompt<{ imageUrl: string }>([
        { type: 'input', name: 'imageUrl', message: 'Image URL' },
      ]);
      image = imageUrl || undefined;
    } else if (imageSrc === 'path') {
      const { imagePath } = await prompt<{ imagePath: string }>([
        { type: 'input', name: 'imagePath', message: 'Image file path' },
      ]);
      if (imagePath) {
        try {
          const exists = await fs.pathExists(imagePath);
          if (exists) {
            image = await fileToDataUrl(imagePath);
            console.log(pc.dim(`Embedded image from path: ${imagePath}`));
          } else {
            console.log(pc.yellow('Image path not found; ignoring.'));
          }
        } catch (e) {
          console.log(pc.yellow(`Failed to read image path: ${String(e)}`));
        }
      }
    } else if (imageSrc === 'file') {
      console.log(pc.dim('Opening image picker...'));
      const picked = await pickFileViaWindowsExplorer('Select an image to embed');
      if (picked) {
        image = await fileToDataUrl(picked);
        console.log(pc.dim(`Embedded image from file: ${picked}`));
      } else {
        console.log(pc.yellow('No image selected.'));
        const { wantPath } = await prompt<{ wantPath: boolean }>([
          { type: 'confirm', name: 'wantPath', message: 'Enter an image file path instead?', initial: false },
        ]);
        if (wantPath) {
          const { imagePathManual } = await prompt<{ imagePathManual: string }>([
            { type: 'input', name: 'imagePathManual', message: 'Image file path' },
          ]);
          try {
            const exists = await fs.pathExists(imagePathManual);
            if (exists) {
              image = await fileToDataUrl(imagePathManual);
              console.log(pc.dim(`Embedded image from path: ${imagePathManual}`));
            } else {
              console.log(pc.yellow('Image path not found; ignoring.'));
            }
          } catch (e) {
            console.log(pc.yellow(`Failed to read image path: ${String(e)}`));
          }
        }
      }
    }
  }

  const advancedToggle = await prompt<{ advanced: boolean }>([
    { type: 'confirm', name: 'advanced', message: 'Configure advanced options?', initial: false },
  ]);

  let advanced: any = {};
  if (advancedToggle.advanced) {
    advanced = await prompt<{
      vibrateStr?: string;
      tag?: string;
      renotify: boolean;
      requireInteraction: boolean;
      silent: boolean;
      dir: 'auto' | 'ltr' | 'rtl';
      lang?: string;
      timestampNow: boolean;
      timestamp?: string;
      actionsCount: string;
    }>([
      { type: 'input', name: 'vibrateStr', message: 'Vibrate pattern (comma-separated numbers)', initial: '' },
      { type: 'input', name: 'tag', message: 'Tag', initial: '' },
      { type: 'confirm', name: 'renotify', message: 'Re-notify existing tag?', initial: false },
      { type: 'confirm', name: 'requireInteraction', message: 'Require interaction?', initial: false },
      { type: 'confirm', name: 'silent', message: 'Silent?', initial: false },
      { type: 'select', name: 'dir', message: 'Direction', choices: ['auto', 'ltr', 'rtl'], initial: 0 },
      { type: 'input', name: 'lang', message: 'Lang (e.g., en-US)', initial: '' },
      { type: 'confirm', name: 'timestampNow', message: 'Use current timestamp?', initial: true },
  { type: 'input', name: 'timestamp', message: 'Timestamp (ms since epoch)', initial: '', skip: (state: any) => !!state.answers.timestampNow },
      { type: 'select', name: 'actionsCount', message: 'Add how many actions?', choices: ['0', '1', '2'], initial: 0 },
    ]);
  }

  const actions: NotificationAction[] = [];
  const actionsCount = Number(advanced.actionsCount || 0);
  for (let i = 0; i < actionsCount; i++) {
    const a = await prompt<{ title: string; action: string; icon?: string }>([
      { type: 'input', name: 'title', message: `Action #${i + 1} title` },
      { type: 'input', name: 'action', message: `Action #${i + 1} action key` },
      { type: 'input', name: 'icon', message: `Action #${i + 1} icon URL (optional)`, initial: '' },
    ]);
    actions.push({ title: a.title, action: a.action, icon: a.icon || undefined });
  }

  const { addData } = await prompt<{ addData: boolean }>([
    { type: 'confirm', name: 'addData', message: 'Attach custom JSON data?', initial: false },
  ]);
  let data: any = undefined;
  if (addData) {
    const { dataJson } = await prompt<{ dataJson: string }>([
      { type: 'input', name: 'dataJson', message: 'Enter JSON (single line)', initial: '{"sentBy":"push-cli"}' },
    ]);
    try {
      data = JSON.parse(dataJson);
    } catch {
      console.log(pc.yellow('Invalid JSON; ignoring data.'));
    }
  }

  const sendOptions = await prompt<{ ttl: string; urgency: Urgency; topic: string }>([
    { type: 'input', name: 'ttl', message: 'TTL seconds (default 2419200 ~ 28 days)', initial: '2419200' },
    { type: 'select', name: 'urgency', message: 'Urgency', choices: ['very-low', 'low', 'normal', 'high'], initial: 2 },
    { type: 'input', name: 'topic', message: 'Topic (optional)', initial: '' },
  ]);

  const vibrate = (advanced.vibrateStr || '')
    .split(',')
    .map((x: string) => x.trim())
    .filter(Boolean)
    .map((x: string) => Number(x))
    .filter((n: number) => Number.isFinite(n) && n >= 0);

  const payload: NotificationPayload = {
    title: base.title,
    body: base.body || undefined,
    icon: base.addIcon ? icon : undefined,
    image,
    badge: base.addBadge
      ? (
          (
            await prompt<{ badgeUrl: string }>([
              { type: 'input', name: 'badgeUrl', message: 'Badge URL' },
            ])
          ).badgeUrl || undefined
        )
      : undefined,
    vibrate: vibrate.length ? vibrate : undefined,
    actions: actions.length ? actions : undefined,
    data,
    tag: advanced.tag || undefined,
    renotify: !!advanced.renotify,
    requireInteraction: !!advanced.requireInteraction,
    silent: !!advanced.silent,
    dir: advanced.dir || 'auto',
    lang: advanced.lang || undefined,
    timestamp: advanced.timestampNow ? Date.now() : advanced.timestamp ? Number(advanced.timestamp) || undefined : undefined,
  };

  return {
    payload,
    sendOptions: {
      TTL: Number(sendOptions.ttl) || undefined,
      urgency: sendOptions.urgency,
      topic: sendOptions.topic || undefined,
    },
  };
}

function previewPayload(payload: NotificationPayload, sendOptions: SendOptions): void {
  const json = JSON.stringify({ payload, sendOptions }, null, 2);
  const line = '-'.repeat(60);
  console.log(pc.green(line));
  console.log(pc.bold(pc.green('Preview')));
  console.log(pc.green(line));
  console.log(json);
  console.log(pc.green(line));
}

async function confirmProceed(): Promise<boolean> {
  const { proceed } = await prompt<{ proceed: boolean }>([
    { type: 'confirm', name: 'proceed', message: 'Send this notification?', initial: true },
  ]);
  return proceed;
}

function startProgress(label: string) {
  let pct = 0;
  const render = () => {
    const width = 30;
    const filled = Math.round((pct / 100) * width);
    const bar = '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']';
    const line = `${pc.cyan(label)} ${bar} ${pct.toString().padStart(3, ' ')}%`;
    process.stdout.write(`\r${line}`);
  };
  render();
  const timer = setInterval(() => {
    pct = Math.min(90, pct + 3);
    render();
  }, 120);
  return {
    update(to: number, newLabel?: string) {
      pct = Math.max(0, Math.min(100, to));
      if (newLabel) label = newLabel;
      render();
    },
    stop(finalLabel?: string) {
      clearInterval(timer);
      if (finalLabel) label = finalLabel;
      pct = 100;
      render();
      process.stdout.write('\n');
    },
  };
}

async function sendPush(
  subscription: SubscriptionLike,
  jsonPayload: string,
  options: SendOptions
): Promise<{ ok: boolean; status?: number; body?: string; headers?: Record<string, string> } | never> {
  const prog = startProgress('Loading');
  prog.update(10, 'Encrypting');
  await new Promise((r) => setTimeout(r, 300));
  prog.update(30, 'Packing');
  await new Promise((r) => setTimeout(r, 300));
  prog.update(50, 'Sending');
  try {
    const resp = await webPush.sendNotification(subscription as any, jsonPayload, options as any);
    prog.stop('Done');
    const status = (resp as any)?.statusCode as number | undefined;
    const body: string | undefined = (resp as any)?.body;
    const headers: Record<string, string> | undefined = (resp as any)?.headers;
    return { ok: status ? status >= 200 && status < 300 : true, status, body, headers };
  } catch (err: any) {
    prog.stop('Error');
    if (err?.statusCode) {
      return { ok: false, status: err.statusCode, body: err?.body };
    }
    throw err;
  }
}

async function main() {
  header();

  const [, , endpointArg, authArg, p256dhArg] = process.argv;
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage(true);
    return;
  }

  let endpoint = endpointArg;
  let auth = authArg;
  let p256dh = p256dhArg;

  const errors = validateArgs(endpoint, auth, p256dh);
  if (errors.length) {
    console.log(pc.yellow('Arguments missing or invalid. You can paste them now.'));
    const ans = await prompt<{ endpoint: string; auth: string; p256dh: string }>([
      { type: 'input', name: 'endpoint', message: 'Endpoint', initial: endpoint || '' },
      { type: 'input', name: 'auth', message: 'Auth (base64url)', initial: auth || '' },
      { type: 'input', name: 'p256dh', message: 'p256dh (base64url)', initial: p256dh || '' },
    ]);
    endpoint = ans.endpoint;
    auth = ans.auth;
    p256dh = ans.p256dh;
  }

  const validation = validateArgs(endpoint, auth, p256dh);
  if (validation.length) {
    console.log(pc.red('Validation errors:'));
    for (const e of validation) console.log(' - ' + pc.red(e));
    usage(true);
    return;
  }

  console.log(pc.dim('Subscription loaded.'));

  // Credentials
  const creds = await askCredentials();
  if (creds.mode === 'vapid') {
    webPush.setVapidDetails(creds.subject, creds.publicKey, creds.privateKey);
    console.log(pc.dim('Using VAPID. Ensure the public key matches the client subscription.'));
  } else {
    webPush.setGCMAPIKey(creds.serverKey);
    console.log(pc.dim('Using FCM Legacy Server Key. This is deprecated and may not work in all cases.'));
  }

  // Builder
  const { payload, sendOptions } = await askNotificationPayload();

  // Preview
  previewPayload(payload, sendOptions);

  const proceed = await confirmProceed();
  if (!proceed) {
    console.log(pc.yellow('Cancelled by user.'));
    process.exit(0);
  }

  const subscription: SubscriptionLike = {
    endpoint: endpoint!,
    keys: { auth: auth!, p256dh: p256dh! },
  };

  const jsonPayload = JSON.stringify(payload);

  try {
    const result = await sendPush(subscription, jsonPayload, sendOptions);
    if (result.ok) {
      console.log(pc.bold(pc.green('Notification sent successfully.')));
      if (result.status) console.log(pc.dim(`Status: ${result.status}`));
    } else {
      console.log(pc.bold(pc.red('Send failed')));
      console.log(`Status: ${result.status || 'unknown'}`);
      if (result.body) console.log(pc.dim(result.body));
      process.exitCode = 2;
    }
  } catch (e: any) {
    console.error(pc.bold(pc.red(`Error: ${e?.message || String(e)}`)));
    process.exitCode = 3;
  }
}

main().catch((e) => {
  console.error(pc.bold(pc.red(`Fatal: ${e?.message || String(e)}`)));
  process.exit(4);
});

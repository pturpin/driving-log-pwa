import { formatDate, formatTime, formatMinutes } from './utils.js';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Opens a new window with a print-friendly log — date, times, day/night
 * split, running totals, and a signature line. Uses the browser's native
 * Print -> Save as PDF, so no PDF library is needed.
 */
export function printLog(item) {
  const sessions = [...item.sessions].sort((a, b) => new Date(a.start) - new Date(b.start));

  let runningDay = 0;
  let runningNight = 0;
  const rows = sessions
    .map((s) => {
      runningDay += s.dayMinutes;
      runningNight += s.dayMinutes ? s.dayMinutes : 0; // placeholder, corrected below
      return s;
    })
    .map((s) => {
      return `
        <tr>
          <td>${formatDate(s.start)}</td>
          <td>${formatTime(s.start)}&ndash;${formatTime(s.end)}</td>
          <td>${formatMinutes(s.dayMinutes)}</td>
          <td>${formatMinutes(s.nightMinutes)}</td>
          <td>${s.source === 'manual' ? 'Manual' : 'Logged'}</td>
          <td>${s.note ? escapeHtml(s.note) : ''}</td>
        </tr>`;
    })
    .join('');

  const totalDay = sessions.reduce((sum, s) => sum + s.dayMinutes, 0);
  const totalNight = sessions.reduce((sum, s) => sum + s.nightMinutes, 0);

  const html = `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Driving Log — ${item.driverId}</title>
      <style>
        body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #111; padding: 24px; }
        h1 { font-size: 20px; margin-bottom: 4px; }
        .meta { color: #555; margin-bottom: 20px; font-size: 13px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td { border-bottom: 1px solid #ccc; text-align: left; padding: 6px 8px; }
        th { border-bottom: 2px solid #111; }
        tfoot td { border-top: 2px solid #111; border-bottom: none; font-weight: bold; }
        .sig { margin-top: 48px; display: flex; gap: 48px; }
        .sig div { flex: 1; border-top: 1px solid #111; padding-top: 4px; font-size: 12px; color: #555; }
        @media print {
          @page { margin: 1in; }
        }
      </style>
    </head>
    <body>
      <h1>Supervised Driving Practice Log</h1>
      <div class="meta">Driver: ${item.driverId} &nbsp;•&nbsp; Printed ${new Date().toLocaleDateString()}</div>
      <table>
        <thead>
          <tr><th>Date</th><th>Time</th><th>Day</th><th>Night</th><th>Type</th><th>Note</th></tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="2">Total</td><td>${formatMinutes(totalDay)}</td><td>${formatMinutes(totalNight)}</td><td></td><td></td></tr>
        </tfoot>
      </table>
      <div class="sig">
        <div>Parent / Supervising Driver Signature</div>
        <div>Date</div>
      </div>
      <script>window.onload = () => window.print();</script>
    </body>
    </html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
}

/** Downloads sessions + settings (not version/active) as a JSON file. */
export function downloadBackup(item) {
  const backup = {
    driverId: item.driverId,
    exportedAt: new Date().toISOString(),
    sessions: item.sessions,
    settings: item.settings
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `drivelog-${item.driverId}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Parses and validates a backup file's contents.
 * @param {string} text raw file contents
 * @returns {{sessions: Array, settings: Object}}
 * @throws {Error} if the shape is invalid
 */
export function parseBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file isn\'t valid JSON.');
  }
  if (!Array.isArray(parsed.sessions)) {
    throw new Error('Backup file is missing a "sessions" list.');
  }
  if (!parsed.settings || typeof parsed.settings !== 'object') {
    throw new Error('Backup file is missing "settings".');
  }
  return { sessions: parsed.sessions, settings: parsed.settings };
}

'use strict';

/**
 * Outbound identity policy — CommonJS twin of apps/joomla-mcp/src/user-agent.ts.
 * Keep the two in sync; they must present the same identity so an allowlist
 * rule written for one matches the other.
 *
 * gantry-mcp previously sent `gantry-cli/1.0 (Joomla Gantry5 automation)`, which
 * carries no browser tokens and is exactly the shape of UA the origin 403s.
 */

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const VERSION = process.env.SOLUTIO_MCP_VERSION || '1.0';
const PRODUCT_TOKEN = `Solutio-MCP/${VERSION} (+https://solutiosoftware.com)`;
const IDENTIFIED_UA = `${CHROME_UA} ${PRODUCT_TOKEN}`;

const STEALTH_HOSTS = (process.env.SOLUTIO_UA_STEALTH_HOSTS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const MODE_IS_STEALTH =
  (process.env.SOLUTIO_UA_MODE || 'identified').toLowerCase() === 'stealth';

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isIdentified(url) {
  if (process.env.SOLUTIO_USER_AGENT) return false;
  if (MODE_IS_STEALTH) return false;
  const host = url ? hostOf(url) : '';
  if (!host) return true;
  return !STEALTH_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
}

function userAgentFor(url) {
  return process.env.SOLUTIO_USER_AGENT || (isIdentified(url) ? IDENTIFIED_UA : CHROME_UA);
}

function outboundHeaders(url) {
  const headers = { 'user-agent': userAgentFor(url) };
  if (isIdentified(url)) headers['x-solutio-agent'] = `gantry-mcp/${VERSION}`;
  return headers;
}

module.exports = { PRODUCT_TOKEN, isIdentified, userAgentFor, outboundHeaders };

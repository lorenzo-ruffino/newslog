'use strict';

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function loadLocales() {
  const it = require('./locales/it.json');
  const en = require('./locales/en.json');
  return { it, en };
}

function t(locale, key, vars = {}) {
  const locales = loadLocales();
  const messages = locales[locale] || locales['it'];
  const parts = key.split('.');
  let val = messages;
  for (const part of parts) {
    val = val?.[part];
    if (val === undefined) break;
  }
  if (typeof val !== 'string') return key;
  return val.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

function detectLocale(req) {
  const acceptLang = req.headers['accept-language'] || '';
  if (acceptLang.startsWith('en')) return 'en';
  return process.env.DEFAULT_LOCALE || 'it';
}

module.exports = { slugify, t, detectLocale };

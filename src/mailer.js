'use strict';
const nodemailer = require('nodemailer');
const { getSetting } = require('./db');

function smtpSettings() {
  const port = Number(getSetting('smtp_port')) || 587;
  return {
    host: getSetting('smtp_host'),
    port,
    secure: port === 465,
    user: getSetting('smtp_user'),
    pass: getSetting('smtp_pass'),
    from: getSetting('smtp_from') || getSetting('smtp_user'),
  };
}

async function sendMail({ to, subject, text, attachments }) {
  const s = smtpSettings();
  if (!s.host || !s.from) throw new Error('Postfach ist noch nicht eingerichtet (Settings → Excel-Versand).');
  if (!to || !to.length) throw new Error('Keine Empfänger hinterlegt.');
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    connectionTimeout: 15000,
  });
  await transport.sendMail({ from: s.from, to: to.join(', '), subject, text, attachments });
}

module.exports = { sendMail };

'use strict'

const MAIL_ACTIONS = {
  SENT: 'sent',
  SENDING: 'sending'
}

async function sendMail(subject, content, mailTo) {
  try {
    await strapi.plugins['email'].services.email.send({
      to: mailTo ?? process.env.MAILGUN_EMAIL_TO,
      from: process.env.MAILGUN_EMAIL,
      replyTo: process.env.MAILGUN_EMAIL,
      subject,
      text: content,
      html: content,
    })

    return true
  } catch (error) {
    console.log(error)
  }
}

function logMailAction(collection, status, action, user) {
  strapi.log.info(`[ ${collection} status ${status} ] mail ${action} to ${user}`)
}

module.exports = {
  send: sendMail,
  MAIL_ACTIONS,
  logMailAction,
}
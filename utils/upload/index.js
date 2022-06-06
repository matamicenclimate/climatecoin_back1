'use strict'

const mime = require('mime-types')
const fs = require('fs/promises')
const path = require('path')
async function pushFile(ctx) {
  const files = ctx.request.files
  const objectResponse = {}
  for (const key in files) {
    const element = files[key]
    objectResponse[key] = await strapi.plugins.upload.services.upload.upload({
      data: {},
      files: {
        path: element.path,
        name: element.name,
        type: mime.lookup(element.path),
        size: element.size,
      },
    })

    objectResponse[key] = objectResponse[key][0].id
  }

  return objectResponse
}

const readFileFromUploads = async (name) => {
  return await fs.readFile(path.join('public/uploads', `${name}`))
}

module.exports = {
  pushFile,
  readFileFromUploads,
}

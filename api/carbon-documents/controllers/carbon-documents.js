'use strict'

const mailer = require(`${process.cwd()}/utils/mailer`)
const fileUploader = require(`${process.cwd()}/utils/upload`)
const algorandUtils = require(`${process.cwd()}/utils/algorand`)
const ALGORAND_ENUMS = require(`${process.cwd()}/utils/enums/algorand`)
const formatters = require(`${process.cwd()}/utils/formatters`)
const utils = require(`${process.cwd()}/utils`)

const algosdk = require('algosdk')
const { algoClient, algoIndexer } = require(`${process.cwd()}/config/algorand`)

function formatBodyArrays(collectionTypeAtts, requestBody) {
  for (const key of collectionTypeAtts) {
    const incomingAttData = requestBody[key]
    if (incomingAttData) {
      const parsedData = JSON.parse(incomingAttData)
      requestBody[key] = formatters.mongoIdFormatter(parsedData)
    }
  }

  return requestBody
}

async function create(ctx) {
  const collectionName = ctx.originalUrl.substring(1)
  const applicationUid = strapi.api[collectionName].models[collectionName].uid
  const pushFilesResponse = await fileUploader.pushFile(ctx)
  ctx.request.body = { ...ctx.request.body, ...pushFilesResponse }
  const collectionTypeAtts = utils.getAttributesByType(
    strapi.api[collectionName].models[collectionName].attributes,
    'collection',
    'plugin',
  )

  ctx.request.body = formatBodyArrays(collectionTypeAtts, ctx.request.body)
  const createdDocument = await strapi.services[collectionName].create(ctx.request.body)
  if (process.env.NODE_ENV === 'test') {
    return createdDocument
  }

  const url = `${process.env.BASE_URL}${process.env.CONTENT_MANAGER_URL}/${applicationUid}/${createdDocument.id}`
  const mailContent = `User ${ctx.state.user.email} sent a new document.<br>Available here: ${url}`
  await mailer.send('New document', mailContent)
  return createdDocument
}

async function saveNft(data, ownerAddress) {
  const nftsDb = []
  const defaultData = {
    group_id: data.groupId,
    carbon_document: data['carbon_document']._id,
    last_config_txn: null,
  }
  const userDb = await strapi.plugins['users-permissions'].services.user.fetch({
    email: data['carbon_document'].created_by_user,
  })
  const nftsData = [
    {
      ...defaultData,
      txn_type: ALGORAND_ENUMS.TXN_TYPES.ASSET_CREATION,
      metadata: data.assetNftMetadata,
      asa_id: data.developerAsaId,
      asa_txn_id: data.txn,
      owner_address: userDb.publicAddress,
    },
    {
      ...defaultData,
      txn_type: ALGORAND_ENUMS.TXN_TYPES.FEE_ASSET_CREATION,
      metadata: data.assetNftMetadata,
      asa_id: data.climateFeeNftId,
      asa_txn_id: data.txn,
      owner_address: ownerAddress,
    },
  ]

  for (const nft of nftsData) {
    const nftDb = await strapi.services['nfts'].create(nft)
    nftsDb.push(nftDb)
  }

  return nftsDb
}

function getBaseMetadata(carbonDocument, options = {}) {
  const mintDefaults = ALGORAND_ENUMS.MINT_DEFAULTS
  const fee = ALGORAND_ENUMS.FEES.FEE
  if (!carbonDocument || !options.txType) {
    return
  }

  return {
    standard: options.standard ?? ALGORAND_ENUMS.ARCS.ARC69,
    description: options.description ?? `${mintDefaults.METADATA_DESCRIPTION} ${carbonDocument._id}`,
    external_url: options.external_url ?? mintDefaults.EXTERNAL_URL,
    mime_type: options.mime_type ?? ALGORAND_ENUMS.MINT_MIME_TYPES.PDF,
    properties: {
      Serial_Number: carbonDocument.serial_number ?? null,
      Provider: carbonDocument.registry.name ?? '',
    },
  }
}

/**
 *
 * @param {algosdk.Algodv2} algodclient
 * @param {*} creator
 * @param {*} carbonDocument
 * @returns
 */
const mintCarbonNft = async (algodclient, creator, carbonDocument) => {
  const atc = new algosdk.AtomicTransactionComposer()
  const indexerClient = algoIndexer()

  const suggestedParams = await algodclient.getTransactionParams().do()
  const assetMetadata = getBaseMetadata(carbonDocument, { txType: ALGORAND_ENUMS.TXN_TYPES.ASSET_CREATION })

  atc.addMethodCall({
    appID: Number(process.env.APP_ID),
    method: algorandUtils.getMethodByName('create_nft'),
    sender: creator.addr,
    signer: algosdk.makeBasicAccountTransactionSigner(creator),
    suggestedParams,
    note: algorandUtils.encodeMetadataText(assetMetadata),
    methodArgs: [Number(carbonDocument.credits)],
  })

  try {
    const result = await atc.execute(algodclient, 2)
    const transactionId = result.txIDs[0]
    const transactionInfo = await indexerClient.searchForTransactions().address(creator.addr).txid(transactionId).do()
    const txnsCfg = transactionInfo.transactions[0]['inner-txns'].filter(
      (transaction) => transaction['tx-type'] === 'acfg',
    )

    const feeAsaTxn = txnsCfg[0]
    const developerAsaTxn = txnsCfg[1]
    const mintData = {
      groupId: developerAsaTxn.group,
      developerAsaId: developerAsaTxn['created-asset-index'],
      txn: transactionId,
      climateFeeNftId: feeAsaTxn['created-asset-index'],
      assetNftMetadata: assetMetadata,
      carbon_document: carbonDocument,
    }

    return await saveNft(mintData, creator.addr)
  } catch (error) {
    strapi.log.error(error)
  }
}

async function mint(ctx) {
  const { id } = ctx.params
  const carbonDocument = await strapi.services['carbon-documents'].findOne({ id })
  if (!['completed'].includes(carbonDocument.status)) {
    return ctx.badRequest("Document hasn't been reviewed")
  }

  const algodclient = algoClient()

  const creator = algosdk.mnemonicToSecretKey(process.env.ALGO_MNEMONIC)
  const nftsDb = await mintCarbonNft(algodclient, creator, carbonDocument)

  // update carbon document with nfts ids
  const carbonDocuments = await strapi.services['carbon-documents'].update(
    { id },
    {
      ...carbonDocument,
      status: 'minted',
      developer_nft: nftsDb[0],
      fee_nft: nftsDb[1],
    },
  )

  return carbonDocuments
}

async function claim(ctx) {
  const { id } = ctx.params
  const carbonDocument = await strapi.services['carbon-documents'].findOne({ id })
  if (!['minted'].includes(carbonDocument.status)) {
    return ctx.badRequest("Document hasn't been minted")
  }

  const algodclient = algoClient()
  const indexerClient = algoIndexer()
  const creator = algosdk.mnemonicToSecretKey(process.env.ALGO_MNEMONIC)

  const userDb = await strapi.plugins['users-permissions'].services.user.fetch({
    email: carbonDocument.created_by_user,
  })
  const developerPublicAddress = userDb.publicAddress

  const developerNft = carbonDocument.developer_nft
  const assetId = Number(developerNft.asa_id)

  await claimNft(algodclient, indexerClient, creator, assetId, developerPublicAddress)

  const updatedCarbonDocument = await strapi.services['carbon-documents'].update(
    { id: carbonDocument },
    { status: 'claimed' },
  )

  return updatedCarbonDocument
}

async function claimNft(algodclient, indexerClient, creator, assetId, developerPublicAddress) {
  const atc = new algosdk.AtomicTransactionComposer()

  const assetInfo = await indexerClient.searchForAssets().index(assetId).do()
  const total = assetInfo.assets[0].params.total

  const suggestedParams = await algodclient.getTransactionParams().do()
  atc.addMethodCall({
    appID: Number(process.env.APP_ID),
    method: algorandUtils.getMethodByName('move'),
    sender: creator.addr,
    signer: algosdk.makeBasicAccountTransactionSigner(creator),
    suggestedParams,
    methodArgs: [
      Number(assetId),
      algorandUtils.getEscrowFromApp(Number(process.env.APP_ID)),
      developerPublicAddress,
      total,
    ],
  })

  const result = await atc.execute(algodclient, 2)

  return result
}

async function swap(ctx) {
  const { id } = ctx.params
  const carbonDocument = await strapi.services['carbon-documents'].findOne({ id })
  if (!['claimed'].includes(carbonDocument.status)) {
    return ctx.badRequest("Document hasn't been claimed")
  }

  const updatedCarbonDocument = await strapi.services['carbon-documents'].update({ id }, { status: 'swapped' })

  return updatedCarbonDocument
}

module.exports = {
  create,
  mint,
  claim,
  swap,
}

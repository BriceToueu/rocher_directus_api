/**
 * G-immo — paiement en ligne par agrégateur. Une seule interface pour quatre fournisseurs :
 *
 *   simulation   tant que les identifiants ne sont pas fournis : une page du site simule la réussite ou l'échec ;
 *   geniuspay    https://pay.genius.ci  (en-têtes X-API-Key / X-API-Secret, webhook signé HMAC-SHA256) ;
 *   cinetpay     nouvelle API (connexion /v1/oauth/login par pays, /v1/payment, notify_token) ;
 *   paydunya     checkout-invoice (en-têtes PAYDUNYA-*, confirmation par jeton).
 *
 * Choix et identifiants : variables du .env de Directus (voir .env.example, section « Paiement en ligne »).
 * Règle de sécurité : une notification ne vaut jamais preuve de paiement ; le statut est TOUJOURS relu auprès du
 * fournisseur (lireStatut) avant d'activer quoi que ce soit.
 *
 * Statuts internes : en_attente | reussie | echouee | annulee | expiree.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const FOURNISSEURS = ['simulation', 'geniuspay', 'cinetpay', 'paydunya']
const DELAI_MS = 20000

export class ErreurPaiement extends Error {
  constructor(message, details = null) { super(message); this.details = details }
}

const vrai = (v, defaut) => (v == null || v === '' ? defaut : ['1', 'true', 'oui', 'yes'].includes(String(v).toLowerCase()))
const egal = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? '')); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y) }

/** Configuration du fournisseur actif, lue dans l'environnement de Directus. */
export function configuration(env) {
  const code = String(env.PAIEMENT_FOURNISSEUR ?? 'simulation').toLowerCase()
  if (!FOURNISSEURS.includes(code)) throw new ErreurPaiement(`PAIEMENT_FOURNISSEUR inconnu : ${code}`)
  const sandbox = vrai(env.PAIEMENT_SANDBOX, true)
  const manquantes = (cles) => cles.filter(c => !env[c])
  const config = { code, sandbox, manquantes: [] }
  if (code === 'geniuspay') config.manquantes = manquantes(['GENIUSPAY_API_KEY', 'GENIUSPAY_API_SECRET'])
  if (code === 'cinetpay') config.manquantes = manquantes(['CINETPAY_API_KEY', 'CINETPAY_API_PASSWORD'])
  if (code === 'paydunya') config.manquantes = manquantes(['PAYDUNYA_MASTER_KEY', 'PAYDUNYA_PRIVATE_KEY', 'PAYDUNYA_TOKEN'])
  return config
}

async function http(methode, url, { entetes = {}, corps } = {}) {
  let r
  try {
    r = await fetch(url, {
      method: methode, signal: AbortSignal.timeout(DELAI_MS),
      headers: { Accept: 'application/json', ...(corps ? { 'Content-Type': 'application/json' } : {}), ...entetes },
      body: corps ? JSON.stringify(corps) : undefined,
    })
  } catch (e) {
    throw new ErreurPaiement('Le service de paiement ne répond pas. Réessayez dans quelques instants.', { erreur: e.message })
  }
  const texte = await r.text()
  let json = null
  try { json = texte ? JSON.parse(texte) : {} } catch { json = { brut: texte.slice(0, 500) } }
  return { status: r.status, ok: r.ok, json }
}

// ── GeniusPay ────────────────────────────────────────────────────────────────────────────────────────────────────
const geniuspay = {
  base: (env) => String(env.GENIUSPAY_BASE_URL || 'https://pay.geniuspay.io/api/v1/merchant').replace(/\/$/, ''),
  entetes: (env) => ({ 'X-API-Key': env.GENIUSPAY_API_KEY, 'X-API-Secret': env.GENIUSPAY_API_SECRET }),
  statut: (s) => ({ completed: 'reussie', pending: 'en_attente', processing: 'en_attente', failed: 'echouee', cancelled: 'annulee', expired: 'expiree', refunded: 'annulee' }[String(s ?? '').toLowerCase()] ?? 'en_attente'),
  async creer(env, p) {
    const r = await http('POST', `${this.base(env)}/payments`, {
      entetes: this.entetes(env),
      corps: {
        amount: p.montant, currency: p.devise, description: p.description,
        customer: { name: p.client.nom, email: p.client.email, ...(p.client.telephone ? { phone: p.client.telephone } : {}) },
        success_url: p.urlRetour, error_url: p.urlRetour, metadata: { reference: p.reference },
      },
    })
    const d = r.json?.data ?? r.json ?? {}
    const url = d.checkout_url ?? d.payment_url
    if (!r.ok || !url) throw new ErreurPaiement('Le paiement n’a pas pu être initialisé auprès de GeniusPay.', { status: r.status, reponse: r.json })
    return { referenceFournisseur: d.reference ?? null, urlPaiement: url, jeton: null, details: { status: d.status ?? null } }
  },
  async lire(env, tx) {
    const r = await http('GET', `${this.base(env)}/payments/${encodeURIComponent(tx.reference_fournisseur)}`, { entetes: this.entetes(env) })
    if (!r.ok) throw new ErreurPaiement('Statut GeniusPay illisible.', { status: r.status, reponse: r.json })
    const d = r.json?.data ?? r.json ?? {}
    return { statut: this.statut(d.status), details: { status: d.status ?? null, methode: d.payment_method ?? null, frais: d.fees ?? null } }
  },
  /** Webhook : signature HMAC-SHA256 (hex) du corps brut avec GENIUSPAY_WEBHOOK_SECRET, en-tête X-GeniusPay-Signature. */
  notification(env, { brut, entetes, corps }) {
    if (env.GENIUSPAY_WEBHOOK_SECRET) {
      const attendu = createHmac('sha256', env.GENIUSPAY_WEBHOOK_SECRET).update(brut).digest('hex')
      if (!egal(attendu, entetes['x-geniuspay-signature'])) throw new ErreurPaiement('Signature GeniusPay invalide.')
    }
    const d = corps?.data ?? {}
    return { reference: d.metadata?.reference ?? null, referenceFournisseur: d.reference ?? null }
  },
}

// ── CinetPay (nouvelle API : jeton d'accès par pays) ─────────────────────────────────────────────────────────────
const jetonsCinetpay = new Map()
const cinetpay = {
  base: (env, sandbox) => String(env.CINETPAY_BASE_URL || (sandbox ? 'https://api.cinetpay.net' : 'https://api.cinetpay.co')).replace(/\/$/, ''),
  identifiants: (env, pays) => ({
    api_key: env[`CINETPAY_API_KEY_${pays}`] || env.CINETPAY_API_KEY,
    api_password: env[`CINETPAY_API_PASSWORD_${pays}`] || env.CINETPAY_API_PASSWORD,
  }),
  statut: (s) => ({ SUCCESS: 'reussie', FAILED: 'echouee', INSUFFICIENT_BALANCE: 'echouee', NOT_ALLOWED: 'echouee', USER_IS_BLOCKED: 'echouee', EXPIRED: 'expiree', INITIATED: 'en_attente', PENDING: 'en_attente' }[String(s ?? '').toUpperCase()] ?? 'en_attente'),
  async jeton(env, sandbox, pays, forcer = false) {
    const cle = `${pays}:${sandbox}`
    const j = jetonsCinetpay.get(cle)
    if (!forcer && j && j.expire > Date.now()) return j.valeur
    const r = await http('POST', `${this.base(env, sandbox)}/v1/oauth/login`, { corps: this.identifiants(env, pays) })
    if (!r.json?.access_token) throw new ErreurPaiement('Connexion à CinetPay refusée : vérifiez CINETPAY_API_KEY et CINETPAY_API_PASSWORD.', { status: r.status })
    jetonsCinetpay.set(cle, { valeur: r.json.access_token, expire: Date.now() + Math.min(Number(r.json.expires_in ?? 82800), 82800) * 1000 - 60000 })
    return r.json.access_token
  },
  async appel(env, sandbox, pays, methode, chemin, corps) {
    let r = await http(methode, `${this.base(env, sandbox)}${chemin}`, { entetes: { Authorization: `Bearer ${await this.jeton(env, sandbox, pays)}` }, corps })
    if ([1002, 1003].includes(Number(r.json?.code)) || r.status === 401) {
      r = await http(methode, `${this.base(env, sandbox)}${chemin}`, { entetes: { Authorization: `Bearer ${await this.jeton(env, sandbox, pays, true)}` }, corps })
    }
    return r
  },
  async creer(env, p, sandbox) {
    const [prenom, ...reste] = String(p.client.nom || 'Client').split(' ')
    const r = await this.appel(env, sandbox, p.pays, 'POST', '/v1/payment', {
      currency: p.devise, merchant_transaction_id: p.reference, amount: p.montant, lang: p.langue === 'en' ? 'en' : 'fr',
      designation: p.description.slice(0, 120), client_email: p.client.email, client_first_name: prenom, client_last_name: reste.join(' ') || prenom,
      success_url: p.urlRetour, failed_url: p.urlRetour, notify_url: p.urlNotification, channel: env.CINETPAY_CANAL || 'PUSH',
      ...(p.client.telephone ? { client_phone_number: p.client.telephone } : {}),
    })
    if (!r.json?.payment_url) throw new ErreurPaiement('Le paiement n’a pas pu être initialisé auprès de CinetPay.', { status: r.status, code: r.json?.code, message: r.json?.message })
    return { referenceFournisseur: r.json.transaction_id ?? null, urlPaiement: r.json.payment_url, jeton: r.json.notify_token ?? null, details: { status: r.json.details?.status ?? r.json.status ?? null } }
  },
  async lire(env, tx, sandbox) {
    const r = await this.appel(env, sandbox, tx.pays, 'GET', `/v1/payment/${encodeURIComponent(tx.reference_fournisseur ?? tx.reference)}`)
    if (!r.json?.status) throw new ErreurPaiement('Statut CinetPay illisible.', { status: r.status, code: r.json?.code })
    return { statut: this.statut(r.json.status), details: { status: r.json.status, code: r.json.code ?? null } }
  },
  /** Notification : notify_token comparé au jeton reçu à la création (vérifié par l'appelant avec la transaction). */
  notification(_env, { corps }) {
    if (!corps?.notify_token || !corps?.merchant_transaction_id) throw new ErreurPaiement('Notification CinetPay incomplète.')
    return { reference: corps.merchant_transaction_id, referenceFournisseur: corps.transaction_id ?? null, jeton: corps.notify_token }
  },
}

// ── PayDunya ─────────────────────────────────────────────────────────────────────────────────────────────────────
const paydunya = {
  base: (env, sandbox) => String(env.PAYDUNYA_BASE_URL || `https://app.paydunya.com/${sandbox ? 'sandbox-api' : 'api'}/v1`).replace(/\/$/, ''),
  entetes: (env) => ({ 'PAYDUNYA-MASTER-KEY': env.PAYDUNYA_MASTER_KEY, 'PAYDUNYA-PRIVATE-KEY': env.PAYDUNYA_PRIVATE_KEY, 'PAYDUNYA-TOKEN': env.PAYDUNYA_TOKEN }),
  statut: (s) => ({ completed: 'reussie', pending: 'en_attente', cancelled: 'annulee', canceled: 'annulee', failed: 'echouee', expired: 'expiree' }[String(s ?? '').toLowerCase()] ?? 'en_attente'),
  async creer(env, p, sandbox) {
    const r = await http('POST', `${this.base(env, sandbox)}/checkout-invoice/create`, {
      entetes: this.entetes(env),
      corps: {
        invoice: { total_amount: p.montant, description: p.description, customer: { name: p.client.nom, email: p.client.email, ...(p.client.telephone ? { phone: p.client.telephone } : {}) } },
        store: { name: env.PAYDUNYA_NOM_BOUTIQUE || 'Gocleus Immo' },
        actions: { cancel_url: p.urlRetour, return_url: p.urlRetour, callback_url: p.urlNotification },
        custom_data: { reference: p.reference },
      },
    })
    if (r.json?.response_code !== '00' || !r.json?.token) throw new ErreurPaiement('Le paiement n’a pas pu être initialisé auprès de PayDunya.', { status: r.status, code: r.json?.response_code, message: r.json?.response_text })
    return { referenceFournisseur: r.json.token, urlPaiement: r.json.response_text, jeton: r.json.token, details: {} }
  },
  async lire(env, tx, sandbox) {
    const r = await http('GET', `${this.base(env, sandbox)}/checkout-invoice/confirm/${encodeURIComponent(tx.reference_fournisseur)}`, { entetes: this.entetes(env) })
    if (r.json?.response_code !== '00') throw new ErreurPaiement('Statut PayDunya illisible.', { status: r.status, code: r.json?.response_code })
    return { statut: this.statut(r.json.status), details: { status: r.json.status ?? null, fail_reason: r.json.fail_reason ?? null } }
  },
  /** IPN (formulaire data[...]) : hash = SHA-512 de la clé principale ; le statut est de toute façon relu ensuite. */
  notification(env, { corps }) {
    const d = corps?.data ?? corps ?? {}
    const hash = d.hash
    if (hash && !egal(createHash('sha512').update(String(env.PAYDUNYA_MASTER_KEY ?? '')).digest('hex'), hash)) throw new ErreurPaiement('Signature PayDunya invalide.')
    return { reference: d.custom_data?.reference ?? null, referenceFournisseur: d.invoice?.token ?? null }
  },
}

const ADAPTATEURS = { geniuspay, cinetpay, paydunya }

/**
 * Crée le paiement chez le fournisseur actif.
 * p = { reference, montant (unité principale), devise (code ISO), description, pays (code), langue,
 *       client: { nom, email, telephone? }, urlRetour, urlNotification, urlSimulation }
 */
export async function creerPaiement(env, p) {
  const c = configuration(env)
  if (c.code === 'simulation') return { fournisseur: 'simulation', referenceFournisseur: p.reference, urlPaiement: p.urlSimulation, jeton: null, details: { simulation: 'en_attente' } }
  if (c.manquantes.length) throw new ErreurPaiement(`Paiement en ligne non configuré : ${c.manquantes.join(', ')} manquant(s) dans le .env de Directus.`)
  const r = await ADAPTATEURS[c.code].creer(env, p, c.sandbox)
  return { fournisseur: c.code, ...r }
}

/** Statut réel d'une transaction, relu chez son fournisseur (tx : ligne transactions_paiement + pays de l'agence). */
export async function lireStatut(env, tx) {
  if (tx.fournisseur === 'simulation') return { statut: tx.details?.simulation ?? 'en_attente', details: tx.details ?? {} }
  const c = configuration(env)
  return ADAPTATEURS[tx.fournisseur].lire(env, tx, c.sandbox)
}

/** Lecture d'une notification : { reference?, referenceFournisseur?, jeton? } — lève si la signature est invalide. */
export function lireNotification(env, fournisseur, requete) {
  if (!ADAPTATEURS[fournisseur]) throw new ErreurPaiement('Fournisseur inconnu.')
  return ADAPTATEURS[fournisseur].notification(env, requete)
}

export const jetonValide = (attendu, recu) => egal(attendu, recu)

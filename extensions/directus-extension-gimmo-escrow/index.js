/**
 * G-immo — séquestre (escrow) tenu par l'agence : règles appliquées par Directus avant chaque écriture (Data Studio, API, front).
 *
 * Transactions : référence ESC-AAAA-NNNNN ; devise du pays de l'agence ; payeur ≠ bénéficiaire ; montant > 0 ;
 *   étapes par défaut selon le type (la première, « Fonds reçus », suit les dépôts) ; montant reçu calculé, non modifiable.
 *   Statuts : en_cours ⇄ a_valider (calculé) → liberee ; litige (motif) puis levée (résolution) ; remboursee si des fonds
 *   ont été reçus ; annulee sans fonds reçus. Libération / remboursement : moyen et référence de sortie obligatoires.
 *   Statuts finaux verrouillés.
 * Étapes : validées dans l'ordre, séquestre en cours ; seule la dernière étape terminée peut être annulée ;
 *   « Fonds reçus » est automatique ; une étape terminée ne se supprime pas.
 * Dépôts (paiements liés à un séquestre) : référence, agence, devise et payeur repris du séquestre ;
 *   séquestre en cours ; montant ≤ reste à recevoir.
 */
import { createError } from '@directus/errors'
import { randomBytes } from 'node:crypto'
import { FONDS_RECUS, STATUTS_FINAUX, etapesModele, notifier, recalculer, totalRecu } from '../../lib/gimmo/escrow.js'

const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const fail = (message) => { throw new BusinessRuleError({ message }) }
const pad = (n) => String(n).padStart(2, '0')
const referencePaiement = () => { const d = new Date(); return `PAY-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${[...randomBytes(6)].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('')}` }
const TYPES = ['vente', 'location', 'depot_garantie']

export default ({ filter, action }, { database: db0, logger, services, getSchema, env }) => {
  // événements génériques : vus avant les contrôles génériques de gimmo-rules (voir gimmo-gestion)
  const pour = (collection, act, handler) => filter(`items.${act}`, (payload, meta, context) => meta.collection === collection ? handler(payload, meta, context) : payload)

  // ── Transactions
  pour('transactions_escrow', 'create', async (payload, _meta, { database }) => {
    if (!TYPES.includes(payload.type)) fail('Type de séquestre inconnu (vente, location ou dépôt de garantie).')
    const m = Number(payload.montant)
    if (!Number.isSafeInteger(m) || m <= 0) fail('Le montant séquestré doit être positif.')
    if (!payload.payeur || !payload.beneficiaire) fail('Indiquez le payeur et le bénéficiaire.')
    if (payload.payeur === payload.beneficiaire) fail('Le payeur et le bénéficiaire doivent être deux personnes différentes.')
    if (payload.statut && payload.statut !== 'en_cours') fail('Un séquestre est créé « en cours ».')
    payload.statut = 'en_cours'
    payload.montant_recu = 0
    for (const k of ['date_liberation', 'date_remboursement', 'date_litige', 'litige_par', 'motif_litige', 'resolution_litige', 'moyen_sortie', 'reference_sortie']) delete payload[k]
    if (payload.agence && !payload.devise) {
      payload.devise = (await database('agences as a').join('pays as p', 'p.id', 'a.pays').where('a.id', payload.agence).first('p.devise'))?.devise ?? null
    }
    if (!payload.reference) {
      const annee = new Date().getFullYear()
      const last = await database('transactions_escrow').where('reference', 'like', `ESC-${annee}-%`).orderBy('reference', 'desc').first('reference')
      payload.reference = `ESC-${annee}-${String(last ? Number(last.reference.split('-')[2]) + 1 : 1).padStart(5, '0')}`
    }
    // étapes : modèle du type, ou libellés fournis précédés de « Fonds reçus »
    const fournies = Array.isArray(payload.etapes) ? payload.etapes.map(e => String(e?.libelle ?? '').trim()).filter(Boolean) : []
    if (payload.etapes !== undefined && !Array.isArray(payload.etapes)) fail('Étapes invalides.')
    const modele = etapesModele(payload.type)
    payload.etapes = fournies.length
      ? [modele[0], ...fournies.filter(l => l.toLowerCase() !== modele[0].libelle.toLowerCase()).map(libelle => ({ libelle, terminee: false, code: null }))].map((e, i) => ({ ...e, ordre: i + 1 }))
      : modele
    return payload
  })

  pour('transactions_escrow', 'update', async (payload, meta, { database, accountability }) => {
    if (accountability && ('montant_recu' in payload || 'reference' in payload)) fail('Le montant reçu et la référence sont calculés par la plateforme.')
    if ('etapes' in payload) fail('Les étapes se modifient une par une.')
    for (const id of meta.keys) {
      const t = await database('transactions_escrow').where('id', id).first()
      if (!t) continue
      if (STATUTS_FINAUX.includes(t.statut)) fail('Ce séquestre est clos : il ne peut plus être modifié.')
      const row = { ...t, ...payload }
      const recu = await totalRecu(database, id)
      if ('montant' in payload) {
        const m = Number(payload.montant)
        if (!Number.isSafeInteger(m) || m <= 0) fail('Le montant séquestré doit être positif.')
        if (m < recu) fail('Le montant ne peut pas être inférieur aux fonds déjà reçus.')
      }
      if (('payeur' in payload || 'beneficiaire' in payload) && recu > 0 && (row.payeur !== t.payeur || row.beneficiaire !== t.beneficiaire)) fail('Les parties ne changent plus une fois des fonds reçus.')
      if (row.payeur === row.beneficiaire) fail('Le payeur et le bénéficiaire doivent être deux personnes différentes.')
      if ('type' in payload && payload.type !== t.type) fail('Le type d’un séquestre ne change pas.')
      if (!('statut' in payload) || payload.statut === t.statut) continue

      const cible = payload.statut
      const etapesRestantes = Number((await database('etapes_escrow').where({ transaction: id, terminee: false }).count({ n: '*' }).first())?.n ?? 0)
      const sortie = () => {
        if (!row.moyen_sortie || !String(row.reference_sortie ?? '').trim()) fail('Indiquez le moyen et la référence du versement.')
      }
      if (cible === 'liberee') {
        if (t.statut === 'litige') fail('Un litige est en cours : levez-le avant de libérer les fonds.')
        if (recu < Number(row.montant)) fail('Les fonds ne sont pas entièrement reçus.')
        if (etapesRestantes > 0) fail('Toutes les étapes doivent être validées avant la libération.')
        sortie()
        payload.date_liberation = new Date().toISOString()
      } else if (cible === 'remboursee') {
        if (recu <= 0) fail('Aucun fonds reçu : annulez le séquestre au lieu de le rembourser.')
        sortie()
        payload.date_remboursement = new Date().toISOString()
      } else if (cible === 'annulee') {
        if (recu > 0) fail('Des fonds ont été reçus : remboursez-les plutôt que d’annuler.')
      } else if (cible === 'litige') {
        if (!['en_cours', 'a_valider'].includes(t.statut)) fail('Un litige ne peut être ouvert que sur un séquestre en cours.')
        if (!String(row.motif_litige ?? '').trim()) fail('Le motif du litige est obligatoire.')
        payload.date_litige = new Date().toISOString()
        // payeur / bénéficiaire : seulement depuis leur lien signé (endpoint public, sans utilisateur) ; sinon l'agence
        payload.litige_par = !accountability?.user && ['payeur', 'beneficiaire'].includes(payload.litige_par) ? payload.litige_par : 'agence'
        payload.resolution_litige = null
      } else if (['en_cours', 'a_valider'].includes(cible)) {
        if (t.statut !== 'litige') fail('Ce statut est calculé à partir des étapes et des dépôts.')
        if (!String(payload.resolution_litige ?? '').trim()) fail('Indiquez la décision prise pour lever le litige.')
        payload.statut = 'en_cours' // recalculé ensuite (a_valider si tout est prêt)
      } else fail('Statut de séquestre inconnu.')
    }
    return payload
  })

  pour('transactions_escrow', 'delete', async (keys, _meta, { database, accountability }) => {
    if (accountability?.admin) return keys
    const avecFonds = await database('paiements').whereIn('transaction_escrow', keys).where('statut', 'confirme').first('id')
    if (avecFonds) fail('Un séquestre ayant reçu des fonds ne se supprime pas : remboursez-le ou libérez-le.')
    return keys
  })

  // ── Étapes
  const transactionDe = async (db, id) => {
    const t = await db('transactions_escrow').where('id', id).first('id', 'statut')
    if (!t) fail('Séquestre introuvable.')
    return t
  }
  pour('etapes_escrow', 'create', async (payload, _meta, { database }) => {
    const t = await transactionDe(database, payload.transaction)
    if (STATUTS_FINAUX.includes(t.statut)) fail('Ce séquestre est clos.')
    if (!String(payload.libelle ?? '').trim()) fail('Le libellé de l’étape est obligatoire.')
    if (payload.code && (payload.code !== FONDS_RECUS || await database('etapes_escrow').where({ transaction: t.id, code: FONDS_RECUS }).first('id'))) fail('Code d’étape réservé.')
    if (payload.terminee && payload.code !== FONDS_RECUS) fail('Une nouvelle étape commence non validée.')
    if (!payload.ordre) payload.ordre = Number((await database('etapes_escrow').where('transaction', t.id).max({ m: 'ordre' }).first())?.m ?? 0) + 1
    return payload
  })
  pour('etapes_escrow', 'update', async (payload, meta, { database, accountability }) => {
    if ('transaction' in payload || 'code' in payload) fail('Une étape reste attachée à son séquestre.')
    for (const id of meta.keys) {
      const e = await database('etapes_escrow').where('id', id).first()
      if (!e) continue
      const t = await transactionDe(database, e.transaction)
      if (STATUTS_FINAUX.includes(t.statut)) fail('Ce séquestre est clos.')
      if ('ordre' in payload && e.terminee) fail('Une étape terminée ne change pas de place.')
      if (!('terminee' in payload) || !!payload.terminee === !!e.terminee) continue
      if (e.code === FONDS_RECUS && accountability) fail('L’étape « Fonds reçus » se valide automatiquement à réception des fonds.')
      if (t.statut === 'litige') fail('Un litige est en cours : les étapes sont gelées.')
      if (payload.terminee) {
        const avant = await database('etapes_escrow').where('transaction', e.transaction).where('ordre', '<', e.ordre).where('terminee', false).first('libelle')
        if (avant) fail(`Validez d’abord l’étape « ${avant.libelle} ».`)
        payload.date_validation = new Date().toISOString()
        payload.validee_par = accountability?.user ?? null
      } else {
        const apres = await database('etapes_escrow').where('transaction', e.transaction).where('ordre', '>', e.ordre).where('terminee', true).first('libelle')
        if (apres) fail(`L’étape « ${apres.libelle} » est déjà validée : annulez-la d’abord.`)
        payload.date_validation = null
        payload.validee_par = null
      }
    }
    return payload
  })
  pour('etapes_escrow', 'delete', async (keys, _meta, { database, accountability }) => {
    if (accountability?.admin && !accountability.user) return keys
    const rows = await database('etapes_escrow as e').join('transactions_escrow as t', 't.id', 'e.transaction').whereIn('e.id', keys).select('e.terminee', 'e.code', 't.statut')
    if (rows.some(r => STATUTS_FINAUX.includes(r.statut))) fail('Ce séquestre est clos.')
    if (rows.some(r => r.terminee)) fail('Une étape validée ne se supprime pas.')
    if (rows.some(r => r.code === FONDS_RECUS)) fail('L’étape « Fonds reçus » est obligatoire.')
    return keys
  })

  // ── Dépôts : paiements liés à un séquestre
  async function controlerDepot(db, row, id = null) {
    const t = await db('transactions_escrow').where('id', row.transaction_escrow).first()
    if (!t) fail('Séquestre introuvable.')
    if (row.echeance) fail('Un dépôt de séquestre n’est pas un loyer.')
    if (row.statut === 'confirme') {
      if (!['en_cours', 'a_valider'].includes(t.statut)) fail('Ce séquestre n’accepte plus de dépôt.')
      const m = Number(row.montant)
      if (!Number.isSafeInteger(m) || m <= 0) fail('Le montant du dépôt doit être positif.')
      const reste = Number(t.montant) - await totalRecu(db, t.id, id)
      if (reste <= 0) fail('Les fonds sont déjà entièrement reçus.')
      if (m > reste) fail('Le dépôt dépasse le reste à recevoir.')
    }
    if (row.devise && Number(row.devise) !== Number(t.devise)) fail('La devise du dépôt doit être celle du séquestre.')
    return t
  }
  filter('paiements.items.create', async (payload, _meta, { database }) => {
    if (!payload.transaction_escrow) return payload
    const t = await controlerDepot(database, payload)
    payload.devise ??= t.devise
    payload.agence ??= t.agence
    payload.payeur ??= t.payeur
    payload.reference ??= referencePaiement()
    if (payload.statut === 'confirme' && !payload.date_paiement) payload.date_paiement = new Date().toISOString()
    return payload
  })
  filter('paiements.items.update', async (payload, meta, { database }) => {
    if (!['transaction_escrow', 'montant', 'statut', 'devise'].some(k => k in payload)) return payload
    for (const id of meta.keys) {
      const p = await database('paiements').where('id', id).first()
      const row = { ...p, ...payload }
      if (p?.transaction_escrow && 'transaction_escrow' in payload && payload.transaction_escrow !== p.transaction_escrow) fail('Un dépôt reste attaché à son séquestre.')
      if (!row.transaction_escrow) continue
      const t = await database('transactions_escrow').where('id', row.transaction_escrow).first('statut')
      if (STATUTS_FINAUX.includes(t?.statut)) fail('Ce séquestre est clos : ses dépôts ne changent plus.')
      if (row.statut === 'confirme') await controlerDepot(database, row, id)
    }
    return payload
  })

  // ── Recalcul (les endpoints recalculent aussi avant de répondre)
  const recalc = async (ids) => {
    for (const id of new Set(ids.filter(Boolean))) {
      try { await recalculer(db0, id) } catch (err) { logger.error(err, `gimmo-escrow : séquestre ${id} non recalculé`) }
    }
  }
  const transactionsDesPaiements = (ids) => db0('paiements').whereIn('id', ids).whereNotNull('transaction_escrow').pluck('transaction_escrow')
  action('paiements.items.create', async (meta) => { if (meta.payload.transaction_escrow) await recalc([meta.payload.transaction_escrow]) })
  action('paiements.items.update', async (meta) => recalc(await transactionsDesPaiements(meta.keys)))
  action('etapes_escrow.items.create', async (meta) => recalc([meta.payload.transaction]))
  action('etapes_escrow.items.update', async (meta) => recalc(await db0('etapes_escrow').whereIn('id', meta.keys).pluck('transaction')))
  action('transactions_escrow.items.update', async (meta) => { if ('montant' in meta.payload || 'statut' in meta.payload) await recalc(meta.keys) })
  // ouverture : les parties reçoivent leur lien de suivi
  action('transactions_escrow.items.create', async (meta) => notifier(db0, meta.key, 'creation', null, { services, schema: await getSchema(), env, logger }))
}

/**
 * G-immo — séquestre (escrow) tenu par l'agence : les fonds sont sur le compte séquestre de l'agence ou chez le notaire ;
 * la plateforme suit les dépôts, les étapes, le litige et la sortie des fonds (libération ou remboursement).
 *
 *  - Étapes par défaut selon le type ; l'étape « fonds reçus » (code fonds_recus) suit les dépôts.
 *  - recalculer : montant reçu (paiements confirmés liés), étape « fonds reçus », statut en_cours ⇄ a_valider.
 *  - Liens des parties : jeton = HMAC-SHA256(secret Directus, id + rôle) ; rien n'est stocké, rien ne se devine.
 *  - notifier : e-mail au payeur et au bénéficiaire (historique dans messages), avec leur lien de suivi.
 */
import crypto from 'node:crypto'
import { montant, nomContact } from './commun.js'
import { creerEtEnvoyer } from './communication.js'
import { langueContact, tr } from './i18n.js'

export const MODELES_ETAPES = {
  vente: ['Fonds reçus', 'Vérification des documents', 'Compromis signé', 'Acte authentique', 'Transfert du titre'],
  location: ['Fonds reçus', 'Bail signé', 'État des lieux d’entrée', 'Remise des clés'],
  depot_garantie: ['Fonds reçus', 'État des lieux de sortie', 'Restitution ou retenues'],
}
export const FONDS_RECUS = 'fonds_recus'
export const STATUTS_FINAUX = ['liberee', 'remboursee', 'annulee']
export const ROLES = ['payeur', 'beneficiaire']
export const TYPE_LIBELLE = { vente: 'vente', location: 'location', depot_garantie: 'dépôt de garantie' }

/** Étapes initiales d'un type de séquestre (la première suit les dépôts). */
export const etapesModele = (type) => (MODELES_ETAPES[type] ?? MODELES_ETAPES.vente).map((libelle, i) => ({ libelle, ordre: i + 1, terminee: false, code: i === 0 ? FONDS_RECUS : null }))

export function jeton(secret, id, role) {
  return crypto.createHmac('sha256', String(secret)).update(`gimmo-escrow:${id}:${role}`).digest('base64url')
}
export function jetonValide(secret, id, role, fourni) {
  if (!ROLES.includes(role) || typeof fourni !== 'string' || fourni.length > 100) return false
  const a = Buffer.from(jeton(secret, id, role)), b = Buffer.from(fourni)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
export const lienPartie = (siteUrl, secret, id, role, langue = 'fr') => `${String(siteUrl ?? '').replace(/\/$/, '')}${langue === 'en' ? '/en' : ''}/sequestre/${id}?r=${role}&j=${jeton(secret, id, role)}`

/** Total des dépôts confirmés d'un séquestre. */
export async function totalRecu(db, id, exclure = null) {
  const q = db('paiements').where({ transaction_escrow: id, statut: 'confirme' })
  if (exclure) q.whereNot('id', exclure)
  return Number((await q.sum({ s: 'montant' }).first())?.s ?? 0)
}

/** Recalcule montant reçu, étape « fonds reçus » et statut en_cours ⇄ a_valider. @returns l'état après calcul */
export async function recalculer(database, id) {
  return database.transaction(async (trx) => {
    const t = await trx('transactions_escrow').where('id', id).forUpdate().first('id', 'montant', 'montant_recu', 'statut')
    if (!t) return null
    const recu = await totalRecu(trx, id)
    const maj = {}
    if (recu !== Number(t.montant_recu)) maj.montant_recu = recu
    const complet = recu >= Number(t.montant)
    const fonds = await trx('etapes_escrow').where({ transaction: id, code: FONDS_RECUS }).first('id', 'terminee')
    if (fonds && !!fonds.terminee !== complet && !STATUTS_FINAUX.includes(t.statut)) {
      await trx('etapes_escrow').where('id', fonds.id).update({ terminee: complet, date_validation: complet ? new Date() : null, validee_par: null })
    }
    const restantes = Number((await trx('etapes_escrow').where({ transaction: id, terminee: false }).count({ n: '*' }).first())?.n ?? 0)
    const nbEtapes = Number((await trx('etapes_escrow').where({ transaction: id }).count({ n: '*' }).first())?.n ?? 0)
    if (t.statut === 'en_cours' && nbEtapes > 0 && restantes === 0 && complet) maj.statut = 'a_valider'
    if (t.statut === 'a_valider' && (restantes > 0 || !complet)) maj.statut = 'en_cours'
    if (Object.keys(maj).length) await trx('transactions_escrow').where('id', id).update(maj)
    return { ...t, ...maj, montant_recu: recu, complet, restantes }
  })
}

const EVENEMENTS = {
  // textes : clés françaises traduites pour chaque partie (lib/gimmo/i18n-en.json)
  creation: (t, x, L) => ({ sujet: tr(L, 'Séquestre {ref} ouvert', { ref: t.reference }), corps: tr(L, 'Un séquestre de {montant} a été ouvert pour « {titre} » ({type}).\nLes fonds sont conservés par l’agence jusqu’à ce que toutes les étapes soient validées.', { montant: t.montantTexte, titre: t.titre, type: tr(L, TYPE_LIBELLE[t.type] ?? t.type) }) }),
  depot: (t, x, L) => ({ sujet: tr(L, 'Séquestre {ref} : dépôt reçu', { ref: t.reference }), corps: tr(L, 'Un dépôt de {depot} a été enregistré. Total reçu : {recu} sur {montant}.', { depot: x.montantTexte, recu: t.recuTexte, montant: t.montantTexte }) }),
  etape: (t, x, L) => ({ sujet: tr(L, 'Séquestre {ref} : étape validée', { ref: t.reference }), corps: tr(L, 'L’étape « {etape} » a été validée par l’agence.', { etape: tr(L, x.libelle) }) }),
  litige: (t, x, L) => ({ sujet: tr(L, 'Séquestre {ref} : litige ouvert', { ref: t.reference }), corps: tr(L, 'Un litige a été signalé. Les fonds restent bloqués jusqu’à la décision de l’agence.\nMotif : {motif}', { motif: t.motif_litige ?? '—' }) }),
  levee: (t, x, L) => ({ sujet: tr(L, 'Séquestre {ref} : litige levé', { ref: t.reference }), corps: tr(L, 'L’agence a levé le litige.\nDécision : {decision}', { decision: t.resolution_litige ?? '—' }) }),
  liberee: (t, x, L) => ({ sujet: tr(L, 'Séquestre {ref} : fonds libérés', { ref: t.reference }), corps: tr(L, 'Les fonds ({recu}) ont été versés au bénéficiaire. Référence : {ref}.', { recu: t.recuTexte, ref: t.reference_sortie ?? '—' }) }),
  remboursee: (t, x, L) => ({ sujet: tr(L, 'Séquestre {ref} : fonds remboursés', { ref: t.reference }), corps: tr(L, 'Les fonds ({recu}) ont été remboursés au payeur. Référence : {ref}.', { recu: t.recuTexte, ref: t.reference_sortie ?? '—' }) }),
  annulee: (t, x, L) => ({ sujet: tr(L, 'Séquestre {ref} annulé', { ref: t.reference }), corps: tr(L, 'Le séquestre a été annulé avant tout dépôt.') }),
}

/**
 * Informe le payeur et le bénéficiaire (e-mail, si renseigné) d'un événement, avec leur lien de suivi.
 * Ne lève jamais : une notification manquée ne doit pas annuler l'opération.
 */
export async function notifier(database, id, evenement, extra, ctx) {
  try {
    const t = await database('transactions_escrow as t').leftJoin('devises as d', 'd.id', 't.devise').where('t.id', id)
      .first('t.*', 'd.code as devise_code', 'd.symbole as devise_symbole', 'd.decimales as devise_decimales')
    if (!t || !EVENEMENTS[evenement]) return 0
    const devise = { code: t.devise_code, symbole: t.devise_symbole, decimales: t.devise_decimales }
    let n = 0
    for (const role of ROLES) {
      const c = await database('contacts').where('id', t[role]).first('id', 'email', 'prenom', 'nom', 'raison_sociale')
      if (!c?.email) continue
      // chaque partie est informée dans sa langue (compte en ligne, sinon pays de l'agence)
      const L = await langueContact(database, c.id)
      const vue = { ...t, montantTexte: montant(t.montant, devise, L), recuTexte: montant(t.montant_recu, devise, L) }
      const x = { ...extra, montantTexte: extra?.montant != null ? montant(extra.montant, devise, L) : '' }
      const { sujet, corps } = EVENEMENTS[evenement](vue, x, L)
      const lien = lienPartie(ctx.env.GIMMO_SITE_URL, ctx.env.SECRET, t.id, role, L)
      const contenu = tr(L, 'Bonjour {nom},\n\n{corps}\n\nSuivre le séquestre ou signaler un problème : {lien}\n\n{{agence}} — {{telephone_agence}}', { nom: nomContact(c), corps, lien })
      await creerEtEnvoyer(database, { contact: c.id, canal: 'email', sujet, contenu, lien }, ctx)
      n++
    }
    return n
  } catch (err) {
    ctx.logger?.error(err, `gimmo-escrow : notification « ${evenement} » du séquestre ${id} non envoyée`)
    return 0
  }
}

/**
 * G-immo — comptabilité en partie double (SYSCOHADA révisé, vision de l'agence mandataire).
 *
 * Une pièce (pieces_comptables) porte des lignes (ecritures_comptables) équilibrées : total débit = total crédit.
 * Une pièce validée est définitive ; on la corrige par contre-passation (pièce aux lignes inversées).
 *
 * Écritures automatiques, recalculées à partir de leur source (synchroniser) :
 *  - paiement de loyer confirmé : D trésorerie (selon le moyen) / C 467100 propriétaire mandant (471000 si inconnu) ;
 *    pour un propriétaire indépendant, C 706400 revenus locatifs (ses loyers sont ses produits) ;
 *  - reversement payé : D 467100 / C 706100 honoraires, 706200 commissions, 447100 taxes, 401100 autres dépenses,
 *    trésorerie pour le net versé (les travaux liés à un ticket sont déjà comptabilisés à la résolution du ticket) ;
 *  - ticket résolu avec un coût : D 467100 (propriétaire), 624100 (agence) ou 411100 (locataire) / C 401100 prestataire ;
 *  - dépôt de séquestre confirmé : D trésorerie / C 467200 fonds reçus en séquestre (payeur) ;
 *  - séquestre libéré ou remboursé : D 467200 / C trésorerie (moyen de sortie des fonds).
 * Si la source change (annulation, montant…), la pièce active est contre-passée et une nouvelle est passée.
 * Tout se fait dans une transaction, sous verrou consultatif : idempotent, sans doublon même en cas d'appels concurrents.
 */
import crypto from 'node:crypto'
import { isoDate, todayIso } from './commun.js'

export const JOURNAUX = ['banque', 'caisse', 'mobile_money', 'ventes', 'achats', 'operations_diverses']
export const C = {
  fournisseurs: '401100', locataires: '411100', etat: '447100', mandants: '467100', sequestre: '467200', attente: '471000', revenusLocatifs: '706400',
  banque: '521100', mobile: '552100', caisse: '571100', entretien: '624100', honoraires: '706100', commissions: '706200',
}
// moyen de paiement → [compte de trésorerie, journal]
const TRESORERIE = { especes: [C.caisse, 'caisse'], mobile_money: [C.mobile, 'mobile_money'], virement: [C.banque, 'banque'], carte: [C.banque, 'banque'], cheque: [C.banque, 'banque'] }
const tresorerie = (type) => TRESORERIE[type] ?? [C.banque, 'banque']

export class ErreurComptable extends Error {}
const fail = (m) => { throw new ErreurComptable(m) }
const VERROU_NUMERO = 715001

// Plan comptable et pays des agences changent rarement : mémorisés 5 minutes (chaque requête coûte un aller-retour réseau).
const CACHE_MS = 5 * 60 * 1000
const cache = new Map()
async function memo(cle, calcul) {
  const e = cache.get(cle)
  if (e && e.expire > Date.now()) return e.valeur
  const valeur = await calcul()
  cache.set(cle, { valeur, expire: Date.now() + CACHE_MS })
  return valeur
}

/** Compte actif par numéro : celui du pays de l'agence s'il existe, sinon le compte commun. */
async function compteParNumero(trx, numero, pays) {
  const id = await memo(`compte:${numero}:${pays ?? ''}`, async () => {
    const rows = await trx('comptes_comptables').where({ numero, actif: true }).where(q => q.whereNull('pays').orWhere('pays', pays ?? -1)).select('id', 'pays')
    return (rows.find(r => r.pays != null) ?? rows[0])?.id ?? null
  })
  if (!id) { cache.delete(`compte:${numero}:${pays ?? ''}`); fail(`Compte ${numero} absent du plan comptable.`) }
  return id
}

/** Agence : pays et devise (la devise de la pièce est celle du pays de l'agence). */
export async function contexteAgence(db, agence) {
  const a = await memo(`agence:${agence}`, () => db('agences as a').join('pays as p', 'p.id', 'a.pays').where('a.id', agence).first('a.id', 'a.pays', 'a.type_compte', 'p.devise'))
  if (!a) { cache.delete(`agence:${agence}`); fail('Agence introuvable.') }
  return a
}

/** Contrôle des lignes d'une pièce ; renvoie le total. */
export function controlerLignes(lignes) {
  if (!Array.isArray(lignes) || lignes.length < 2) fail('Une pièce compte au moins deux lignes.')
  let d = 0, c = 0
  for (const [i, l] of lignes.entries()) {
    const debit = Number(l.debit ?? 0), credit = Number(l.credit ?? 0)
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit) || debit < 0 || credit < 0) fail(`Ligne ${i + 1} : montants entiers positifs attendus.`)
    if ((debit > 0) === (credit > 0)) fail(`Ligne ${i + 1} : renseignez soit un débit, soit un crédit.`)
    if (!l.compte) fail(`Ligne ${i + 1} : compte manquant.`)
    d += debit; c += credit
  }
  if (d !== c) fail(`Pièce déséquilibrée : débit ${d} ≠ crédit ${c}.`)
  return d
}

async function numeroPiece(trx, date) {
  await trx.raw('select pg_advisory_xact_lock(?)', [VERROU_NUMERO])
  const annee = isoDate(date).slice(0, 4)
  const last = await trx('pieces_comptables').where('numero', 'like', `ECR-${annee}-%`).orderBy('numero', 'desc').first('numero')
  return `ECR-${annee}-${String(last ? Number(last.numero.split('-')[2]) + 1 : 1).padStart(5, '0')}`
}

/** Remplace les lignes d'une pièce (numéro de ligne = numéro de pièce/rang). */
async function ecrireLignes(trx, piece, lignes) {
  await trx('ecritures_comptables').where('piece', piece.id).delete()
  if (!lignes.length) return
  await trx('ecritures_comptables').insert(lignes.map((l, i) => ({
    id: crypto.randomUUID(), piece: piece.id, numero: `${piece.numero}/${i + 1}`, date_ecriture: piece.date_piece, libelle: (l.libelle || piece.libelle).slice(0, 255),
    compte: l.compte, debit: Number(l.debit ?? 0), credit: Number(l.credit ?? 0), devise: piece.devise, agence: piece.agence,
    bien: l.bien ?? null, tiers: l.tiers ?? null, prestataire: l.prestataire ?? null, ticket: l.ticket ?? null, date_created: new Date(), user_created: piece.user ?? null,
  })))
}

/**
 * Crée une pièce et ses lignes (comptes déjà résolus en identifiants).
 * @param {object} p { agence, devise, date, libelle, journal, origine, statut, paiement, reversement, ticket, contrepassation_de, piece_justificative, user, lignes }
 */
export async function creerPiece(trx, p) {
  const total = controlerLignes(p.lignes)
  if (!JOURNAUX.includes(p.journal)) fail('Journal inconnu.')
  const statut = p.statut ?? 'validee'
  const piece = {
    id: crypto.randomUUID(), numero: await numeroPiece(trx, p.date), date_piece: isoDate(p.date), libelle: String(p.libelle).slice(0, 255), journal: p.journal,
    origine: p.origine ?? 'manuelle', statut, total, agence: p.agence, devise: p.devise, paiement: p.paiement ?? null, reversement: p.reversement ?? null, ticket: p.ticket ?? null, transaction_escrow: p.transaction_escrow ?? null,
    contrepassation_de: p.contrepassation_de ?? null, piece_justificative: p.piece_justificative ?? null,
    date_validation: statut === 'validee' ? new Date() : null, valide_par: statut === 'validee' ? p.user ?? null : null, user_created: p.user ?? null, date_created: new Date(),
  }
  await trx('pieces_comptables').insert(piece)
  await ecrireLignes(trx, { ...piece, user: p.user }, p.lignes)
  return { id: piece.id, numero: piece.numero }
}

/** Modifie un brouillon (en-tête et lignes). */
export async function modifierBrouillon(trx, id, p) {
  const piece = await trx('pieces_comptables').where('id', id).forUpdate().first()
  if (!piece) fail('Pièce introuvable.')
  if (piece.statut !== 'brouillon') fail('Seul un brouillon peut être modifié ; une pièce validée se corrige par contre-passation.')
  const total = controlerLignes(p.lignes)
  if (p.journal && !JOURNAUX.includes(p.journal)) fail('Journal inconnu.')
  const maj = { date_piece: isoDate(p.date ?? piece.date_piece), libelle: String(p.libelle ?? piece.libelle).slice(0, 255), journal: p.journal ?? piece.journal, total, piece_justificative: p.piece_justificative !== undefined ? p.piece_justificative : piece.piece_justificative, date_updated: new Date(), user_updated: p.user ?? null }
  await trx('pieces_comptables').where('id', id).update(maj)
  await ecrireLignes(trx, { ...piece, ...maj, user: p.user }, p.lignes)
}

export async function validerPiece(trx, id, user) {
  const piece = await trx('pieces_comptables').where('id', id).forUpdate().first()
  if (!piece) fail('Pièce introuvable.')
  if (piece.statut !== 'brouillon') fail('Cette pièce est déjà validée.')
  controlerLignes(await trx('ecritures_comptables').where('piece', id).select('compte', 'debit', 'credit'))
  await trx('pieces_comptables').where('id', id).update({ statut: 'validee', date_validation: new Date(), valide_par: user ?? null })
}

export async function supprimerBrouillon(trx, id) {
  const piece = await trx('pieces_comptables').where('id', id).forUpdate().first()
  if (!piece) fail('Pièce introuvable.')
  if (piece.statut !== 'brouillon') fail('Une pièce validée ne se supprime pas : contre-passez-la.')
  await trx('pieces_comptables').where('id', id).delete()
}

/** Contre-passe une pièce validée : nouvelle pièce aux lignes inversées, l'originale passe « contre-passée ». */
export async function contrepasser(trx, id, { date, user, motif } = {}) {
  const piece = await trx('pieces_comptables').where('id', id).forUpdate().first()
  if (!piece) fail('Pièce introuvable.')
  if (piece.statut !== 'validee') fail(piece.statut === 'brouillon' ? 'Un brouillon se supprime ou se modifie, il ne se contre-passe pas.' : 'Cette pièce est déjà contre-passée.')
  const lignes = await trx('ecritures_comptables').where('piece', id).orderBy('numero').select('compte', 'debit', 'credit', 'libelle', 'bien', 'tiers', 'prestataire', 'ticket')
  const d = isoDate(date ?? todayIso())
  const r = await creerPiece(trx, {
    agence: piece.agence, devise: piece.devise, date: d < isoDate(piece.date_piece) ? piece.date_piece : d, libelle: `Contre-passation ${piece.numero}${motif ? ` — ${motif}` : ''}`,
    journal: piece.journal, origine: 'contrepassation', statut: 'validee', paiement: piece.paiement, reversement: piece.reversement, ticket: piece.ticket, transaction_escrow: piece.transaction_escrow, contrepassation_de: piece.id, user,
    lignes: lignes.map(l => ({ ...l, debit: Number(l.credit), credit: Number(l.debit), libelle: `Contre-passation — ${l.libelle}` })),
  })
  await trx('pieces_comptables').where('id', id).update({ statut: 'contrepassee' })
  return r
}

// ── Écritures automatiques

/** Propriétaire mandant d'un bien : mandat de gestion actif, sinon propriétaire principal en cours. */
async function proprietaireDe(trx, bien) {
  if (!bien) return null
  const m = await trx('mandats as m').join('mandats_biens as mb', 'mb.mandats_id', 'm.id').where({ 'mb.biens_id': bien, 'm.type': 'gestion_locative', 'm.statut': 'actif' }).first('m.mandant')
  if (m?.mandant) return m.mandant
  return (await trx('biens_proprietaires').where('biens_id', bien).whereNull('date_fin').orderBy('quote_part', 'desc').first('contacts_id'))?.contacts_id ?? null
}

/** Écriture attendue pour un encaissement de loyer (null si rien à comptabiliser). */
async function attenduPaiement(trx, id) {
  const p = await trx('paiements as p').leftJoin('moyens_paiement as m', 'm.id', 'p.moyen_paiement').leftJoin('echeances as e', 'e.id', 'p.echeance').leftJoin('baux as b', 'b.id', 'e.bail').leftJoin('biens as bi', 'bi.id', 'b.bien')
    .where('p.id', id).first('p.id', 'p.reference', 'p.statut', 'p.montant', 'p.date_paiement', 'p.agence', 'p.devise', 'p.echeance', 'p.transaction_escrow', 'p.payeur', 'm.type as moyen', 'b.bien', 'bi.titre', 'e.libelle as periode')
  if (!p || p.statut !== 'confirme' || !(Number(p.montant) > 0)) return null
  if (!p.echeance && p.transaction_escrow) return attenduDepot(trx, p)
  if (!p.echeance) return null
  const ag = await contexteAgence(trx, p.agence)
  const [tres, journal] = tresorerie(p.moyen)
  // propriétaire indépendant : le loyer est son produit ; sinon il est dû au propriétaire mandant (fonds de tiers)
  const independant = ag.type_compte === 'proprietaire_independant'
  const proprio = independant ? null : await proprietaireDe(trx, p.bien)
  const periode = /^loyer\b/i.test(p.periode ?? '') ? p.periode : `Loyer ${p.periode ?? ''}` // libellé d'échéance « Loyer octobre 2026 »
  const libelle = `${periode} — ${p.titre ?? 'bien'} (${p.reference})`.replace(/\s+/g, ' ')
  return {
    agence: p.agence, devise: p.devise ?? ag.devise, date: p.date_paiement ?? new Date(), journal, libelle, origine: 'paiement', paiement: p.id,
    lignes: [
      { compte: await compteParNumero(trx, tres, ag.pays), debit: Number(p.montant), credit: 0, bien: p.bien, libelle },
      independant
        ? { compte: await compteParNumero(trx, C.revenusLocatifs, ag.pays), debit: 0, credit: Number(p.montant), bien: p.bien, libelle }
        : { compte: await compteParNumero(trx, proprio ? C.mandants : C.attente, ag.pays), debit: 0, credit: Number(p.montant), bien: p.bien, tiers: proprio, libelle: proprio ? libelle : `${libelle} — propriétaire à identifier` },
    ],
  }
}

/** Dépôt de fonds en séquestre : D trésorerie / C 467200 (payeur). */
async function attenduDepot(trx, p) {
  const t = await trx('transactions_escrow').where('id', p.transaction_escrow).first('reference', 'titre', 'bien', 'payeur')
  const ag = await contexteAgence(trx, p.agence)
  const [tres, journal] = tresorerie(p.moyen)
  const libelle = `Dépôt séquestre ${t?.reference ?? ''} — ${t?.titre ?? ''} (${p.reference})`.replace(/\s+/g, ' ')
  return {
    agence: p.agence, devise: p.devise ?? ag.devise, date: p.date_paiement ?? new Date(), journal, libelle, origine: 'paiement', paiement: p.id,
    lignes: [
      { compte: await compteParNumero(trx, tres, ag.pays), debit: Number(p.montant), credit: 0, bien: t?.bien ?? null, libelle },
      { compte: await compteParNumero(trx, C.sequestre, ag.pays), debit: 0, credit: Number(p.montant), bien: t?.bien ?? null, tiers: p.payeur ?? t?.payeur ?? null, libelle },
    ],
  }
}

/** Sortie des fonds séquestrés : libération au bénéficiaire ou remboursement au payeur. */
async function attenduSequestre(trx, id) {
  const t = await trx('transactions_escrow as t').leftJoin('moyens_paiement as m', 'm.id', 't.moyen_sortie').where('t.id', id)
    .first('t.id', 't.reference', 't.titre', 't.statut', 't.montant_recu', 't.payeur', 't.beneficiaire', 't.bien', 't.agence', 't.devise', 't.date_liberation', 't.date_remboursement', 't.reference_sortie', 'm.type as moyen')
  if (!t || !['liberee', 'remboursee'].includes(t.statut) || !(Number(t.montant_recu) > 0)) return null
  const ag = await contexteAgence(trx, t.agence)
  const [tres, journal] = tresorerie(t.moyen)
  const libere = t.statut === 'liberee'
  const libelle = `${libere ? 'Libération' : 'Remboursement'} séquestre ${t.reference} — ${t.titre}${t.reference_sortie ? ` (${t.reference_sortie})` : ''}`
  const m = Number(t.montant_recu)
  return {
    agence: t.agence, devise: t.devise ?? ag.devise, date: (libere ? t.date_liberation : t.date_remboursement) ?? new Date(), journal, libelle, origine: 'sequestre', transaction_escrow: t.id,
    lignes: [
      { compte: await compteParNumero(trx, C.sequestre, ag.pays), debit: m, credit: 0, bien: t.bien, tiers: t.payeur, libelle },
      { compte: await compteParNumero(trx, tres, ag.pays), debit: 0, credit: m, bien: t.bien, tiers: libere ? t.beneficiaire : t.payeur, libelle },
    ],
  }
}

/** Écriture attendue pour un reversement payé au propriétaire. */
async function attenduReversement(trx, id) {
  const r = await trx('reversements as r').leftJoin('moyens_paiement as m', 'm.id', 'r.moyen_paiement').leftJoin('coordonnees_reversement as c', 'c.id', 'r.coordonnees').where('r.id', id)
    .first('r.id', 'r.numero', 'r.statut', 'r.beneficiaire', 'r.montant_net', 'r.date_paiement', 'r.agence', 'r.devise', 'm.type as moyen', 'c.type as type_coordonnees')
  if (!r || r.statut !== 'paye') return null
  const ag = await contexteAgence(trx, r.agence)
  const [tres, journal] = tresorerie(r.moyen ?? r.type_coordonnees) // moyen du versement, sinon type des coordonnées
  const lignesRel = await trx('lignes_reversement').where('reversement', id).orderBy('sort').select('type', 'libelle', 'montant', 'bien', 'ticket')
  const lignes = []
  const deduction = async (numero, l) => {
    const m = -Number(l.montant)
    if (!(m > 0)) return
    lignes.push({ compte: await compteParNumero(trx, C.mandants, ag.pays), debit: m, credit: 0, tiers: r.beneficiaire, bien: l.bien, libelle: `${r.numero} — ${l.libelle}` })
    lignes.push({ compte: await compteParNumero(trx, numero, ag.pays), debit: 0, credit: m, bien: l.bien, libelle: `${r.numero} — ${l.libelle}` })
  }
  for (const l of lignesRel) {
    if (l.type === 'loyer_encaisse') continue // crédité au propriétaire à l'encaissement
    if (l.type === 'travaux' && l.ticket) continue // comptabilisé à la résolution du ticket
    await deduction(l.type === 'honoraires_gestion' ? C.honoraires : l.type === 'commission_mise_en_location' ? C.commissions : l.type === 'taxe' ? C.etat : C.fournisseurs, l)
  }
  const net = Number(r.montant_net)
  if (net > 0) {
    lignes.push({ compte: await compteParNumero(trx, C.mandants, ag.pays), debit: net, credit: 0, tiers: r.beneficiaire, libelle: `${r.numero} — net reversé` })
    lignes.push({ compte: await compteParNumero(trx, tres, ag.pays), debit: 0, credit: net, libelle: `${r.numero} — net reversé` })
  }
  if (!lignes.length) return null
  return { agence: r.agence, devise: r.devise ?? ag.devise, date: r.date_paiement ?? new Date(), journal, libelle: `Reversement ${r.numero}`, origine: 'reversement', reversement: r.id, lignes }
}

/** Écriture attendue pour les frais d'une intervention de maintenance résolue. */
async function attenduTicket(trx, id) {
  const t = await trx('tickets_maintenance as t').join('biens as b', 'b.id', 't.bien').where('t.id', id)
    .first('t.id', 't.reference', 't.titre', 't.statut', 't.cout', 't.imputation', 't.prestataire', 't.date_resolution', 't.bien', 'b.agence')
  if (!t || t.statut !== 'resolu' || !(Number(t.cout) > 0)) return null
  const ag = await contexteAgence(trx, t.agence)
  let compte = C.entretien, tiers = null
  // à la charge du propriétaire : dû par le mandant (467100), ou charge propre du propriétaire indépendant (624100)
  if (t.imputation === 'proprietaire' && ag.type_compte !== 'proprietaire_independant') { compte = C.mandants; tiers = await proprietaireDe(trx, t.bien) }
  else if (t.imputation === 'locataire') {
    compte = C.locataires
    tiers = (await trx('baux').where('bien', t.bien).whereIn('statut', ['en_vigueur', 'litige']).first('locataire'))?.locataire ?? null
  }
  const libelle = `Intervention ${t.reference} — ${t.titre}`
  const cout = Number(t.cout)
  return {
    agence: t.agence, devise: ag.devise, date: t.date_resolution ?? new Date(), journal: 'achats', libelle, origine: 'ticket', ticket: t.id,
    lignes: [
      { compte: await compteParNumero(trx, compte, ag.pays), debit: cout, credit: 0, bien: t.bien, tiers, ticket: t.id, libelle },
      { compte: await compteParNumero(trx, C.fournisseurs, ag.pays), debit: 0, credit: cout, bien: t.bien, prestataire: t.prestataire, ticket: t.id, libelle },
    ],
  }
}

const ATTENDU = { paiement: attenduPaiement, reversement: attenduReversement, ticket: attenduTicket, transaction_escrow: attenduSequestre }
/** Origine des pièces automatiques d'une source (champ de la pièce → valeur de pieces_comptables.origine). */
export const ORIGINE_SOURCE = { paiement: 'paiement', reversement: 'reversement', ticket: 'ticket', transaction_escrow: 'sequestre' }
const signature = (agence, date, lignes) => JSON.stringify([agence, isoDate(date), lignes.map(l => [l.compte, Number(l.debit), Number(l.credit), l.tiers ?? null, l.prestataire ?? null, l.bien ?? null]).sort()])

/**
 * Met la comptabilité en accord avec une source (paiement, reversement, ticket).
 * @returns {'inchange'|'cree'|'contrepasse'|'remplace'}
 */
export async function synchroniser(db, source, id) {
  if (!ATTENDU[source] || !id) return 'inchange'
  return db.transaction(async (trx) => {
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`compta:${source}:${id}`])
    const active = await trx('pieces_comptables').where({ [source]: id, origine: ORIGINE_SOURCE[source], statut: 'validee' }).orderBy('date_created', 'desc').first('id', 'agence', 'date_piece')
    const attendu = await ATTENDU[source](trx, id)
    if (active && attendu) {
      const actuelles = await trx('ecritures_comptables').where('piece', active.id).select('compte', 'debit', 'credit', 'tiers', 'prestataire', 'bien')
      if (signature(active.agence, active.date_piece, actuelles) === signature(attendu.agence, attendu.date, attendu.lignes)) return 'inchange'
    }
    if (!active && !attendu) return 'inchange'
    if (active) await contrepasser(trx, active.id, { motif: attendu ? 'source modifiée' : 'source annulée' })
    if (attendu) await creerPiece(trx, { ...attendu, statut: 'validee' })
    return active ? (attendu ? 'remplace' : 'contrepasse') : 'cree'
  })
}

/** Rattrapage : sources sans écriture, ou écritures dont la source n'est plus comptabilisable. */
let rattrapageEnCours = false
export async function rattraper(db, logger) {
  if (rattrapageEnCours) return 0 // un seul rattrapage à la fois (démarrage et planification peuvent se chevaucher)
  rattrapageEnCours = true
  try { return await rattraperSources(db, logger) } finally { rattrapageEnCours = false }
}
async function rattraperSources(db, logger) {
  const actives = (source) => db('pieces_comptables').where({ origine: ORIGINE_SOURCE[source], statut: 'validee' }).whereNotNull(source).select(source)
  const todo = [
    ...(await db('paiements').where('statut', 'confirme').where(q => q.whereNotNull('echeance').orWhereNotNull('transaction_escrow')).whereNotIn('id', actives('paiement')).limit(200).pluck('id')).map(id => ['paiement', id]),
    ...(await db('paiements').whereNot('statut', 'confirme').whereIn('id', actives('paiement')).limit(200).pluck('id')).map(id => ['paiement', id]),
    ...(await db('reversements').where('statut', 'paye').whereNotIn('id', actives('reversement')).limit(200).pluck('id')).map(id => ['reversement', id]),
    ...(await db('reversements').whereNot('statut', 'paye').whereIn('id', actives('reversement')).limit(200).pluck('id')).map(id => ['reversement', id]),
    ...(await db('tickets_maintenance').where('statut', 'resolu').where('cout', '>', 0).whereNotIn('id', actives('ticket')).limit(200).pluck('id')).map(id => ['ticket', id]),
    ...(await db('transactions_escrow').whereIn('statut', ['liberee', 'remboursee']).where('montant_recu', '>', 0).whereNotIn('id', actives('transaction_escrow')).limit(200).pluck('id')).map(id => ['transaction_escrow', id]),
    ...(await db('transactions_escrow').whereNotIn('statut', ['liberee', 'remboursee']).whereIn('id', actives('transaction_escrow')).limit(200).pluck('id')).map(id => ['transaction_escrow', id]),
    ...(await db('tickets_maintenance').where(q => q.whereNot('statut', 'resolu').orWhereNull('cout').orWhere('cout', '<=', 0)).whereIn('id', actives('ticket')).limit(200).pluck('id')).map(id => ['ticket', id]),
  ]
  let n = 0
  for (const [source, id] of todo) {
    try { if (await synchroniser(db, source, id) !== 'inchange') n++ } catch (err) { logger?.error(err, `gimmo-comptabilite : ${source} ${id} non comptabilisé`) }
  }
  return n
}

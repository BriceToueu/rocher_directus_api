/**
 * G-immo — vérification & confiance.
 *
 *  - Badge « Vérifié » (biens, programmes) : l'entreprise demande la vérification, la plateforme l'accorde, la refuse ou
 *    la retire ; modifier les informations clés d'un bien vérifié retire le badge.
 *  - Identité (KYC) : contrôle manuel par l'entreprise, sur pièce d'identité validée et non expirée.
 *  - Anti double vente : un n° de titre foncier déjà enregistré par une autre entreprise est refusé (message neutre)
 *    et signalé à la plateforme (alertes_plateforme).
 *  - Indice de confiance d'un bien (0–100) : pièces présentes et validées, identité des propriétaires, photo, badge.
 */
import { isoDate, todayIso } from './commun.js'

export const STATUTS_VERIFICATION = ['aucune', 'demandee', 'verifie', 'refusee']
/** Champs du badge : écrits par la plateforme seulement. */
export const CHAMPS_BADGE = ['verifie', 'statut_verification', 'date_verification', 'motif_verification', 'date_demande_verification']
/** Informations dont la modification retire le badge. */
export const CHAMPS_CLES = {
  biens: ['numero_titre_foncier', 'type_bien', 'ville', 'quartier', 'adresse', 'surface_habitable', 'surface_terrain'],
  programmes: ['ville', 'quartier', 'adresse', 'promoteur'],
}
/** Pièces justificatives exigées pour demander la vérification. */
export const PIECES_PROPRIETE = {
  biens: ['titre_foncier', 'attestation_notariee', 'certificat_bornage', 'plan_cadastral'],
  programmes: ['permis_construire', 'titre_foncier', 'attestation_notariee'],
}

/** Forme comparable d'un n° de titre foncier (majuscules, sans espaces ni séparateurs). */
export const normaliserTitre = (v) => String(v ?? '').toUpperCase().replace(/[\s\-./]/g, '')
/** Expression SQL équivalente (Postgres). */
export const SQL_TITRE = "upper(regexp_replace(numero_titre_foncier, '[[:space:]./-]', '', 'g'))"

const ajouterJours = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const valide = (d, jour) => d.statut_verification === 'valide' && (!d.date_expiration || isoDate(d.date_expiration) >= jour)
const deposee = (d) => !!d.fichier && ['en_attente', 'valide'].includes(d.statut_verification)

/** Critères et indice de confiance d'un bien. */
export function indiceBien(b, docs, proprietaires, jour = todayIso()) {
  const de = (types) => docs.filter(d => types.includes(d.type_document))
  const propriete = de(['titre_foncier', 'attestation_notariee'])
  const plan = de(['plan_cadastral', 'certificat_bornage'])
  const criteres = [
    { cle: 'titre', label: 'N° de titre foncier renseigné', points: 15, obtenu: b.numero_titre_foncier ? 15 : 0 },
    { cle: 'propriete', label: 'Titre de propriété validé', points: 30, obtenu: propriete.some(d => valide(d, jour)) ? 30 : propriete.some(deposee) ? 10 : 0 },
    { cle: 'plan', label: 'Plan cadastral ou bornage validé', points: 15, obtenu: plan.some(d => valide(d, jour)) ? 15 : plan.some(deposee) ? 5 : 0 },
    { cle: 'identite', label: 'Identité des propriétaires vérifiée', points: 15, obtenu: proprietaires.length && proprietaires.every(p => p.statut_kyc === 'verifie') ? 15 : 0 },
    { cle: 'photo', label: 'Photo du bien', points: 10, obtenu: b.photo_principale ? 10 : 0 },
    { cle: 'badge', label: 'Vérifié par la plateforme', points: 15, obtenu: b.verifie ? 15 : 0 },
  ]
  return { score: criteres.reduce((s, c) => s + c.obtenu, 0), criteres }
}

/** La vérification peut-elle être demandée ? → message d'erreur ou null. */
export async function controleDemande(db, collection, item) {
  if (item.statut_verification === 'demandee') return 'La vérification est déjà demandée : la plateforme l’examine.'
  if (item.statut_verification === 'verifie') return 'Ce bien est déjà vérifié.'
  if (collection === 'biens' && !item.numero_titre_foncier) return 'Renseignez d’abord le n° de titre foncier du bien.'
  const champ = collection === 'biens' ? 'bien' : 'programme'
  const piece = await db('documents').where(champ, item.id).whereIn('type_document', PIECES_PROPRIETE[collection]).whereNotNull('fichier')
    .whereIn('statut_verification', ['en_attente', 'valide']).first('id')
  if (!piece) return collection === 'biens'
    ? 'Ajoutez d’abord une pièce justificative (titre foncier, attestation notariée, plan cadastral ou bornage).'
    : 'Ajoutez d’abord une pièce justificative (permis de construire, titre foncier ou attestation notariée).'
  return null
}

/** Synthèse de vérification d'une entreprise. */
export async function synthese(db, agence, jour = todayIso()) {
  const biens = await db('biens').where({ agence }).whereNot('statut', 'archive').orderBy('titre')
    .select('id', 'titre', 'reference', 'numero_titre_foncier', 'photo_principale', 'verifie', 'statut_verification', 'motif_verification', 'date_demande_verification')
  const ids = biens.map(b => b.id).concat(['00000000-0000-0000-0000-000000000000'])
  const docsBiens = await db('documents').whereIn('bien', ids).select('bien', 'type_document', 'statut_verification', 'date_expiration', 'fichier')
  const props = await db('biens_proprietaires as bp').join('contacts as c', 'c.id', 'bp.contacts_id').whereIn('bp.biens_id', ids).select('bp.biens_id', 'c.statut_kyc')
  const lignesBiens = biens.map(b => {
    const { score, criteres } = indiceBien(b, docsBiens.filter(d => d.bien === b.id), props.filter(p => p.biens_id === b.id), jour)
    return { ...b, score, criteres }
  })
  const programmes = await db('programmes').where({ agence }).whereNot('statut_publication', 'archive').orderBy('nom')
    .select('id', 'nom', 'verifie', 'statut_verification', 'motif_verification', 'date_demande_verification')

  // documents à contrôler (déposés, en attente) et à renouveler (expirés ou expirant sous 30 jours)
  const DOC = ['d.id', 'd.titre', 'd.type_document', 'd.statut_verification', 'd.date_expiration', 'd.date_created', 'd.fichier', 'd.bien', 'd.programme', 'd.contact', 'd.bail',
    'b.titre as bien_titre', 'p.nom as programme_nom', 'c.prenom as contact_prenom', 'c.nom as contact_nom', 'c.raison_sociale as contact_raison_sociale']
  const docs = (q) => q.from('documents as d').leftJoin('biens as b', 'b.id', 'd.bien').leftJoin('programmes as p', 'p.id', 'd.programme').leftJoin('contacts as c', 'c.id', 'd.contact').where('d.agence', agence).select(DOC)
  const aControler = await docs(db.queryBuilder()).where('d.statut_verification', 'en_attente').whereNotNull('d.fichier').orderBy('d.date_created')
  const aRenouveler = (await docs(db.queryBuilder()).where(q => q.where('d.statut_verification', 'a_renouveler')
    .orWhere(q2 => q2.where('d.statut_verification', 'valide').whereNotNull('d.date_expiration').where('d.date_expiration', '<=', ajouterJours(jour, 30)))).orderBy('d.date_expiration'))
    .map(d => ({ ...d, date_expiration: isoDate(d.date_expiration) }))

  // identité : locataires (bail en cours ou à signer) et propriétaires de l'entreprise
  const locataires = db('baux as l').join('biens as b', 'b.id', 'l.bien').where('b.agence', agence).whereIn('l.statut', ['en_attente_signature', 'en_vigueur', 'litige']).select('l.locataire as id')
  const proprietaires = db('biens_proprietaires as bp').join('biens as b', 'b.id', 'bp.biens_id').where('b.agence', agence).select('bp.contacts_id as id')
  const contacts = await db('contacts').where({ agence }).where(q => q.whereIn('id', locataires).orWhereIn('id', proprietaires))
    .select('id', 'prenom', 'nom', 'raison_sociale', 'statut_kyc', 'date_kyc', 'motif_kyc', 'type_personne')
  const pieces = await db('documents').whereIn('contact', contacts.map(c => c.id).concat(['00000000-0000-0000-0000-000000000000'])).where('type_document', 'piece_identite')
    .orderBy('date_created', 'desc').select('id', 'contact', 'statut_verification', 'date_expiration', 'fichier')
  const roleDe = new Set((await locataires).map(x => x.id))
  const identites = contacts.map(c => {
    const p = pieces.filter(d => d.contact === c.id)
    const pieceValide = p.find(d => valide(d, jour))
    return {
      ...c, date_kyc: isoDate(c.date_kyc), role: roleDe.has(c.id) ? 'locataire' : 'proprietaire',
      piece: pieceValide ? 'valide' : p.find(d => d.statut_verification === 'en_attente' && d.fichier) ? 'a_controler' : p.some(d => d.statut_verification === 'valide') ? 'expiree' : p.length ? 'rejetee' : 'absente',
      piece_id: (pieceValide ?? p.find(d => d.statut_verification === 'en_attente' && d.fichier) ?? p[0])?.id ?? null,
    }
  }).sort((a, b) => (a.statut_kyc === 'verifie') - (b.statut_kyc === 'verifie'))

  return {
    indicateurs: {
      biens: biens.length, verifies: biens.filter(b => b.verifie).length, demandes: biens.filter(b => b.statut_verification === 'demandee').length + programmes.filter(p => p.statut_verification === 'demandee').length,
      score_moyen: lignesBiens.length ? Math.round(lignesBiens.reduce((s, b) => s + b.score, 0) / lignesBiens.length) : null,
      a_controler: aControler.length, a_renouveler: aRenouveler.length,
      identites_verifiees: identites.filter(c => c.statut_kyc === 'verifie').length, identites: identites.length,
    },
    biens: lignesBiens, programmes, a_controler: aControler, a_renouveler: aRenouveler, identites,
  }
}

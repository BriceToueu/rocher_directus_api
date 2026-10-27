/**
 * G-immo — logique partagée des loyers (hook gimmo-loyers et endpoint gimmo-api).
 *
 *  - appliquerEcheance : recalcule le statut d'une échéance à partir de ses paiements confirmés et,
 *    dès qu'elle est entièrement réglée, émet la quittance (numérotation QUI-AAAA-NNNNNN, code de vérification).
 *    Si un paiement est annulé et que l'échéance n'est plus soldée, la quittance est annulée.
 *  - assurerPdfQuittance : génère le PDF de la quittance (une seule fois) et le range dans Directus.
 * Les deux fonctions sont idempotentes et sérialisées par verrou (appel concurrent du hook et de l'endpoint).
 */
import { langueAgence, tr } from './i18n.js'
import PDFDocument from 'pdfkit'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { isoDate, todayIso, dateLongue, montant, nomContact, pdfBuffer, PDF_COULEURS } from './commun.js'

export { isoDate, todayIso }

const LOCK_QUITTANCES = 7_741_100 // verrou de numérotation des quittances

/** Statut d'une échéance non soldée selon sa date d'exigibilité. */
export function statutImpaye(dateEcheance, paye, today = todayIso()) {
  if (paye > 0) return 'partiel'
  if (dateEcheance > today) return 'a_venir'
  return dateEcheance < today ? 'en_retard' : 'en_attente'
}

/** Somme des paiements confirmés d'une échéance (unité mineure), en excluant éventuellement un paiement. */
export async function totalConfirme(db, echeanceId, exclureId = null) {
  const q = db('paiements').where({ echeance: echeanceId, statut: 'confirme' })
  if (exclureId) q.whereNot('id', exclureId)
  const row = await q.sum({ total: 'montant' }).first()
  return Number(row?.total ?? 0)
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function codeVerification() {
  const bytes = randomBytes(12)
  const chars = [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('')
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`
}

/**
 * Recalcule le statut de l'échéance et émet / annule la quittance.
 * @returns {{ statut: string, paye: number, quittance: { id: string, numero: string } | null, nouvelle: boolean } | null}
 */
export async function appliquerEcheance(database, echeanceId, { ItemsService, schema }) {
  if (!echeanceId) return null
  return database.transaction(async (trx) => {
    const e = await trx('echeances').where('id', echeanceId).forUpdate().first()
    if (!e) return null
    const paye = await totalConfirme(trx, echeanceId)
    const du = Number(e.montant_du)
    const soldee = paye >= du
    const statut = e.statut === 'annulee' ? 'annulee' : soldee ? 'payee' : statutImpaye(isoDate(e.date_echeance), paye)
    if (statut !== e.statut) await trx('echeances').where('id', echeanceId).update({ statut })

    let quittance = await trx('quittances').where({ echeance: echeanceId }).whereNot('statut', 'annulee').first('id', 'numero')
    let nouvelle = false
    if (statut === 'payee' && !quittance && e.bail) {
      await trx.raw('select pg_advisory_xact_lock(?)', [LOCK_QUITTANCES])
      const annee = new Date().getFullYear()
      const last = await trx('quittances').where('numero', 'like', `QUI-${annee}-%`).orderBy('numero', 'desc').first('numero')
      const numero = `QUI-${annee}-${String(last ? Number(last.numero.split('-')[2]) + 1 : 1).padStart(6, '0')}`
      const dernier = await trx('paiements').where({ echeance: echeanceId, statut: 'confirme' }).max({ d: 'date_paiement' }).first()
      const loyer = Number(e.montant_loyer ?? e.montant_du)
      const charges = Number(e.montant_charges ?? 0)
      const id = await new ItemsService('quittances', { schema, knex: trx, accountability: null }).createOne({
        numero, type: 'quittance_loyer', bail: e.bail, echeance: echeanceId,
        periode_debut: isoDate(e.periode_debut ?? e.date_echeance), periode_fin: isoDate(e.periode_fin ?? e.date_echeance),
        montant_loyer: loyer, montant_charges: charges, montant_total: loyer + charges, devise: e.devise,
        date_emission: todayIso(), date_paiement: isoDate(dernier?.d ?? new Date()), statut: 'emise', code_verification: codeVerification(),
      }, { emitEvents: false })
      quittance = { id, numero }
      nouvelle = true
    }
    if (statut !== 'payee' && quittance) {
      await trx('quittances').where('id', quittance.id).update({ statut: 'annulee' })
      quittance = null
    }
    return { statut, paye, quittance, nouvelle }
  })
}

// ── PDF ─────────────────────────────────────────────────────────────────────────
async function donneesQuittance(db, id) {
  const q = await db('quittances').where('id', id).first()
  const bail = await db('baux').where('id', q.bail).first()
  const bien = await db('biens').where('id', bail.bien).first()
  const [locataire, agence, devise, ville, quartier] = await Promise.all([
    db('contacts').where('id', bail.locataire).first(),
    db('agences').where('id', bien.agence).first(),
    db('devises').where('id', q.devise).first(),
    bien.ville ? db('villes').where('id', bien.ville).first('nom') : null,
    bien.quartier ? db('quartiers').where('id', bien.quartier).first('nom') : null,
  ])
  const agenceVille = agence?.ville ? await db('villes').where('id', agence.ville).first('nom') : null
  const bailleurs = await db('biens_proprietaires as bp').join('contacts as c', 'c.id', 'bp.contacts_id')
    .where('bp.biens_id', bien.id).whereNull('bp.date_fin').orderBy('bp.est_mandant', 'desc').select('c.prenom', 'c.nom', 'c.raison_sociale')
  const paiements = await db('paiements as p').leftJoin('moyens_paiement as m', 'm.id', 'p.moyen_paiement')
    .where({ 'p.echeance': q.echeance, 'p.statut': 'confirme' }).orderBy('p.date_paiement').select('p.montant', 'p.date_paiement', 'p.reference', 'm.nom as moyen')
  // document contractuel : langue du pays de l'agence
  const langue = await langueAgence(db, bien.agence)
  return { q, bail, bien, locataire, agence, agenceVille, devise, ville, quartier, bailleurs, paiements, langue }
}

function dessinerQuittance(d) {
  const L = d.langue
  const t = (fr, p) => tr(L, fr, p)
  const date = (v) => dateLongue(v, L)
  const somme = (v) => montant(v, d.devise, L)
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: t('Quittance {numero}', { numero: d.q.numero }), Author: d.agence?.nom ?? 'Gocleus Immo', Creator: 'Gocleus Immo' } })
  const { BRAND, ACCENT, MUTED, LINE } = PDF_COULEURS
  const W = doc.page.width - 100

  // En-tête agence
  doc.rect(0, 0, doc.page.width, 8).fill(ACCENT)
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(16).text(d.agence?.nom ?? t('Agence'), 50, 40)
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    .text([d.agence?.adresse, d.agenceVille?.nom].filter(Boolean).join(', ') || ' ')
    .text([d.agence?.telephone, d.agence?.email].filter(Boolean).join('  ·  ') || ' ')
  doc.font('Helvetica-Bold').fontSize(20).fillColor(BRAND).text(t('QUITTANCE DE LOYER'), 50, 40, { width: W, align: 'right' })
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(t('N° {numero}', { numero: d.q.numero }), { width: W, align: 'right' })
    .text(t('Émise le {date}', { date: date(d.q.date_emission) }), { width: W, align: 'right' })

  // Période
  const y0 = 130
  doc.roundedRect(50, y0, W, 44, 6).fill('#EEF7FB')
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(12)
    .text(t('Période du {debut} au {fin}', { debut: date(d.q.periode_debut), fin: date(d.q.periode_fin) }), 64, y0 + 10, { width: W - 28 })
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(t('Bail {ref}', { ref: d.bail.reference ?? '' }), 64, y0 + 27)

  // Parties
  const y1 = y0 + 64
  const col = (x, titre, lignes) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text(titre.toUpperCase(), x, y1, { width: W / 2 - 10 })
    doc.moveDown(0.3).font('Helvetica-Bold').fontSize(11).fillColor('#1A2B3C').text(lignes[0], { width: W / 2 - 10 })
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    for (const l of lignes.slice(1).filter(Boolean)) doc.text(l, { width: W / 2 - 10 })
  }
  col(50, t('Bailleur'), [d.bailleurs.length ? d.bailleurs.map(nomContact).join(', ') : '—', d.agence ? t('Représenté par {agence}, mandataire', { agence: d.agence.nom }) : null])
  col(50 + W / 2 + 10, t('Locataire'), [nomContact(d.locataire), d.locataire?.telephone, d.locataire?.email])

  // Bien
  const y2 = y1 + 90
  doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text(t('BIEN LOUÉ'), 50, y2)
  doc.moveDown(0.3).font('Helvetica-Bold').fontSize(11).fillColor('#1A2B3C').text(d.bien.titre)
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text([d.bien.adresse, d.quartier?.nom, d.ville?.nom].filter(Boolean).join(', ') || ' ')

  // Détail des sommes
  let y = y2 + 60
  const ligne = (label, valeur, gras = false) => {
    doc.font(gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(gras ? 12 : 10).fillColor(gras ? BRAND : '#1A2B3C')
      .text(label, 64, y, { width: W - 200 }).text(valeur, 50 + W - 200, y, { width: 186, align: 'right' })
    y += gras ? 24 : 20
  }
  doc.moveTo(50, y - 8).lineTo(50 + W, y - 8).strokeColor(LINE).lineWidth(1).stroke()
  ligne(t('Loyer hors charges'), somme(d.q.montant_loyer))
  ligne(t('Provision sur charges'), somme(d.q.montant_charges))
  doc.moveTo(50, y - 4).lineTo(50 + W, y - 4).strokeColor(LINE).stroke()
  y += 6
  ligne(t('Total réglé'), somme(d.q.montant_total), true)

  // Paiements
  y += 10
  doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text(t('RÈGLEMENT'), 50, y)
  y += 16
  doc.font('Helvetica').fontSize(9).fillColor('#1A2B3C')
  for (const p of d.paiements) {
    doc.text(`${date(p.date_paiement)} · ${p.moyen ? t(p.moyen) : '—'}${p.reference ? ` · ${t('réf. {ref}', { ref: p.reference })}` : ''}`, 64, y, { width: W - 200 })
      .text(somme(p.montant), 50 + W - 200, y, { width: 186, align: 'right' })
    y += 16
  }

  // Attestation
  y += 18
  doc.font('Helvetica').fontSize(10).fillColor('#1A2B3C').text(
    t('Le bailleur, par l’intermédiaire de son mandataire, reconnaît avoir reçu de {locataire} la somme de {montant} au titre du loyer et des charges de la période indiquée ci-dessus, et lui en donne quittance, sous réserve de tous droits.', { locataire: nomContact(d.locataire), montant: somme(d.q.montant_total) }),
    50, y, { width: W, align: 'justify', lineGap: 2 },
  )

  // Pied : vérification (marge basse levée pour écrire en bas de page sans créer de nouvelle page)
  doc.page.margins.bottom = 0
  const yf = doc.page.height - 110
  doc.moveTo(50, yf).lineTo(50 + W, yf).strokeColor(LINE).stroke()
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text(t('Code de vérification'), 50, yf + 12)
    .font('Helvetica-Bold').fontSize(13).fillColor(BRAND).text(d.q.code_verification, 50, yf + 24)
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text(t('Ce document est établi électroniquement. Le code ci-contre permet à l’agence de confirmer son authenticité. Cette quittance annule tous les reçus qui auraient pu être donnés pour acompte sur la période.'), 50 + W / 2 - 40, yf + 12, { width: W / 2 + 40 })
  doc.fontSize(7).fillColor('#9AA8B6').text('Gocleus Immo — G-immo', 50, doc.page.height - 40, { width: W, align: 'center' })
  doc.end()
  return doc
}

/** Génère et range le PDF de la quittance s'il n'existe pas encore. Renvoie l'identifiant du fichier. */
export async function assurerPdfQuittance(database, quittanceId, { FilesService, schema }) {
  return database.transaction(async (trx) => {
    const q = await trx('quittances').where('id', quittanceId).forUpdate().first('id', 'numero', 'fichier_pdf')
    if (!q) return null
    if (q.fichier_pdf) return q.fichier_pdf
    const buffer = await pdfBuffer(dessinerQuittance(await donneesQuittance(trx, quittanceId)))
    const files = new FilesService({ schema, accountability: null })
    const fileId = await files.uploadOne(Readable.from(buffer), {
      title: `Quittance ${q.numero}`, filename_download: `quittance-${q.numero}.pdf`, type: 'application/pdf',
    })
    await trx('quittances').where('id', quittanceId).update({ fichier_pdf: fileId })
    return fileId
  })
}

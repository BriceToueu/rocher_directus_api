/**
 * G-immo — relevés de gérance (reversements aux propriétaires).
 *
 *  - genererReleves : pour chaque mandat de gestion locative actif visible par l'appelant et chaque propriétaire
 *    des biens couverts (quote-part active), crée en brouillon le relevé de la période :
 *      + loyers encaissés = Σ paiements confirmés de la période × quote-part
 *      − dépenses         = Σ coûts des interventions résolues imputées au propriétaire × quote-part
 *      − honoraires       = loyers encaissés × taux d'honoraires du mandat
 *    Période : le mois (mandat mensuel) ou le trimestre qui se termine ce mois-ci (mandat trimestriel).
 *    Un bien n'est pris en compte qu'entre sa date d'entrée et sa date de sortie du mandat.
 *    Idempotent : un relevé non annulé (mandat, propriétaire, période) n'est pas recréé.
 *  - pdfReleve : PDF du relevé, construit à la volée à partir des données (filigrane « BROUILLON » tant qu'il n'est pas validé).
 */
import { langueAgence, tr } from './i18n.js'
import PDFDocument from 'pdfkit'
import { isoDate, dateLongue, montant, nomContact, pdfBuffer, PDF_COULEURS, MOIS } from './commun.js'

const pad = (n) => String(n).padStart(2, '0')
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** Période d'un mandat pour le mois demandé, ou null si aucun relevé n'est dû ce mois-ci. */
export function periodeDuMandat(periodicite, annee, mois) {
  if (periodicite === 'trimestriel') {
    if (mois % 3 !== 0) return null
    return { debut: `${annee}-${pad(mois - 2)}-01`, fin: `${annee}-${pad(mois)}-${pad(lastDay(annee, mois))}`, libelle: `${['1er', '2e', '3e', '4e'][mois / 3 - 1]} trimestre ${annee}` }
  }
  return { debut: `${annee}-${pad(mois)}-01`, fin: `${annee}-${pad(mois)}-${pad(lastDay(annee, mois))}`, libelle: `${MOIS[mois - 1]} ${annee}` }
}

async function nextNumero(database, annee) {
  const last = await database('reversements').where('numero', 'like', `RG-${annee}-%`).orderBy('numero', 'desc').first('numero')
  const n = last ? Number(last.numero.split('-')[2]) + 1 : 1
  return `RG-${annee}-${String(n).padStart(4, '0')}`
}

/** Coordonnées proposées par défaut : la coordonnée par défaut vérifiée, sinon la coordonnée par défaut. */
async function coordonneesParDefaut(database, contact) {
  const rows = await database('coordonnees_reversement').where('contact', contact).orderBy('par_defaut', 'desc').select('id', 'par_defaut', 'statut_verification')
  return (rows.find(r => r.par_defaut && r.statut_verification === 'verifie') ?? rows.find(r => r.par_defaut) ?? null)?.id ?? null
}

export async function genererReleves({ annee, mois, mandat: mandatId }, { ItemsService, schema, accountability, database }) {
  const svc = (collection) => new ItemsService(collection, { schema, accountability })
  const mandats = await svc('mandats').readByQuery({
    filter: { type: { _eq: 'gestion_locative' }, statut: { _eq: 'actif' }, ...(mandatId ? { id: { _eq: mandatId } } : {}) },
    fields: ['id', 'numero', 'taux_honoraires', 'devise', 'agence', 'periodicite_reversement', 'biens.biens_id', 'biens.date_entree', 'biens.date_sortie'],
    limit: -1,
  })

  const crees = []
  const ignores = []
  const noms = new Map()
  const nom = async (id) => {
    if (!noms.has(id)) noms.set(id, nomContact(await database('contacts').where('id', id).first('prenom', 'nom', 'raison_sociale')))
    return noms.get(id)
  }

  for (const mandat of mandats) {
    const periode = periodeDuMandat(mandat.periodicite_reversement, annee, mois)
    if (!periode) { ignores.push({ mandat: mandat.numero, raison: 'reversement trimestriel : généré en fin de trimestre' }); continue }
    const { debut, fin } = periode

    // biens couverts au moins un jour sur la période, avec leur fenêtre de couverture
    const fenetres = new Map()
    for (const b of mandat.biens ?? []) {
      const entree = isoDate(b.date_entree) ?? '0000-01-01'
      const sortie = isoDate(b.date_sortie) ?? '9999-12-31'
      if (!b.biens_id || entree > fin || sortie < debut) continue
      fenetres.set(b.biens_id, { de: entree > debut ? entree : debut, a: sortie < fin ? sortie : fin })
    }
    const bienIds = [...fenetres.keys()]
    if (!bienIds.length) { ignores.push({ mandat: mandat.numero, raison: 'aucun bien couvert sur la période' }); continue }
    const dansFenetre = (bien, date) => { const f = fenetres.get(bien); const d = isoDate(date); return !!f && !!d && d >= f.de && d <= f.a }

    const parts = await svc('biens_proprietaires').readByQuery({
      filter: { biens_id: { _in: bienIds }, date_fin: { _null: true } },
      fields: ['biens_id', 'contacts_id', 'quote_part'], limit: -1,
    })
    const paiements = (await svc('paiements').readByQuery({
      filter: { statut: { _eq: 'confirme' }, date_paiement: { _between: [`${debut}T00:00:00`, `${fin}T23:59:59`] }, echeance: { bail: { bien: { _in: bienIds } } } },
      fields: ['id', 'montant', 'date_paiement', 'echeance.libelle', 'echeance.bail.bien'], limit: -1,
    })).filter(p => dansFenetre(p.echeance?.bail?.bien, p.date_paiement))
    const tickets = (await svc('tickets_maintenance').readByQuery({
      filter: { bien: { _in: bienIds }, imputation: { _eq: 'proprietaire' }, statut: { _eq: 'resolu' }, cout: { _nnull: true }, date_resolution: { _between: [`${debut}T00:00:00`, `${fin}T23:59:59`] } },
      fields: ['id', 'titre', 'cout', 'bien', 'date_resolution'], limit: -1,
    })).filter(t => dansFenetre(t.bien, t.date_resolution))

    const taux = Number(mandat.taux_honoraires ?? 0)
    for (const contact of [...new Set(parts.map(p => p.contacts_id))]) {
      const quotePart = (bien) => Number(parts.find(p => p.biens_id === bien && p.contacts_id === contact)?.quote_part ?? 0) / 100
      const deja = await database('reversements').where({ mandat: mandat.id, beneficiaire: contact }).where('periode_debut', debut).whereNot('statut', 'annule').first('numero')
      if (deja) { ignores.push({ mandat: mandat.numero, beneficiaire: await nom(contact), raison: `déjà généré (${deja.numero})` }); continue }

      const lignes = []
      let encaisse = 0
      let depenses = 0
      for (const p of paiements) {
        const qp = quotePart(p.echeance.bail.bien)
        if (!qp) continue
        const m = Math.round(Number(p.montant) * qp)
        encaisse += m
        lignes.push({ type: 'loyer_encaisse', libelle: `${p.echeance.libelle ?? 'Loyer'}${qp < 1 ? ` (quote-part ${(qp * 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %)` : ''}`, montant: m, bien: p.echeance.bail.bien, paiement: p.id })
      }
      for (const t of tickets) {
        const qp = quotePart(t.bien)
        if (!qp) continue
        const m = Math.round(Number(t.cout) * qp)
        depenses += m
        lignes.push({ type: 'travaux', libelle: `${t.titre}${qp < 1 ? ` (quote-part ${(qp * 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %)` : ''}`, montant: -m, bien: t.bien, ticket: t.id })
      }
      if (!lignes.length) { ignores.push({ mandat: mandat.numero, beneficiaire: await nom(contact), raison: 'aucun mouvement sur la période' }); continue }

      const honoraires = Math.round(encaisse * taux / 100)
      if (honoraires) lignes.push({ type: 'honoraires_gestion', libelle: `Honoraires de gestion (${taux.toLocaleString('fr-FR')} % des loyers encaissés)`, montant: -honoraires })
      lignes.forEach((l, i) => { l.sort = i + 1 })

      const numero = await nextNumero(database, annee)
      const net = encaisse - honoraires - depenses
      const id = await svc('reversements').createOne({
        numero, mandat: mandat.id, beneficiaire: contact, periode_debut: debut, periode_fin: fin,
        montant_encaisse: encaisse, montant_honoraires: honoraires, montant_depenses: depenses, montant_net: net,
        devise: mandat.devise, statut: 'brouillon', agence: mandat.agence, coordonnees: await coordonneesParDefaut(database, contact), lignes,
      })
      crees.push({ id, numero, mandat: mandat.numero, beneficiaire: await nom(contact), periode: periode.libelle, encaisse, honoraires, depenses, net })
    }
  }
  return { mandats: mandats.length, crees, ignores }
}

/** Libellé de ligne (généré en français) dans la langue du document : « Loyer août 2026 (quote-part 50 %) ». */
const MOIS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
const MOIS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function trLigne(langue, libelle) {
  if (langue !== 'en' || !libelle) return libelle
  return String(libelle).replace(/^Loyer\b/, 'Rent').replace(/\(quote-part ([^)]*)\)/, '(share $1)')
    .replace(new RegExp(`\\b(${MOIS_FR.join('|')})\\b`, 'g'), m => MOIS_EN[MOIS_FR.indexOf(m)])
}

// ── PDF ─────────────────────────────────────────────────────────────────────────
const STATUTS = { brouillon: 'BROUILLON', valide: 'Validé', paye: 'Payé', annule: 'ANNULÉ' }
const masque = (v) => v ? `•••• ${String(v).replace(/\s/g, '').slice(-4)}` : ''

export async function pdfReleve(db, id) {
  const r = await db('reversements').where('id', id).first()
  const [mandat, beneficiaire, agence, devise, lignes] = await Promise.all([
    db('mandats').where('id', r.mandat).first('numero', 'taux_honoraires'),
    db('contacts').where('id', r.beneficiaire).first(),
    db('agences').where('id', r.agence).first(),
    db('devises').where('id', r.devise).first(),
    db('lignes_reversement as l').leftJoin('biens as b', 'b.id', 'l.bien').where('l.reversement', id).orderBy('l.sort').select('l.type', 'l.libelle', 'l.montant', 'b.titre as bien'),
  ])
  const coord = r.coordonnees ? await db('coordonnees_reversement as c').leftJoin('moyens_paiement as m', 'm.id', 'c.moyen_paiement').where('c.id', r.coordonnees).first('c.type', 'c.banque', 'c.iban_rib', 'c.numero_mobile', 'm.nom as operateur') : null
  const moyen = r.moyen_paiement ? await db('moyens_paiement').where('id', r.moyen_paiement).first('nom') : null
  // document contractuel : langue du pays de l'agence
  const L = await langueAgence(db, r.agence)
  const t = (fr, p) => tr(L, fr, p)
  const date = (v) => dateLongue(v, L)
  const somme = (v) => montant(v, devise, L)

  const { BRAND, ACCENT, MUTED, LINE, TEXTE, FOND } = PDF_COULEURS
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: t('Relevé de gérance {numero}', { numero: r.numero }), Author: agence?.nom ?? 'Gocleus Immo', Creator: 'Gocleus Immo' } })
  const W = doc.page.width - 100

  if (r.statut === 'brouillon' || r.statut === 'annule') {
    doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] })
      .font('Helvetica-Bold').fontSize(90).fillColor(r.statut === 'annule' ? '#C62828' : '#B0BEC5').opacity(0.15)
      .text(t(STATUTS[r.statut]), 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center' }).restore()
    doc.opacity(1)
  }

  doc.rect(0, 0, doc.page.width, 8).fill(ACCENT)
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(16).text(agence?.nom ?? t('Agence'), 50, 40)
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    .text([agence?.adresse].filter(Boolean).join(', ') || ' ')
    .text([agence?.telephone, agence?.email].filter(Boolean).join('  ·  ') || ' ')
  doc.font('Helvetica-Bold').fontSize(19).fillColor(BRAND).text(t('RELEVÉ DE GÉRANCE'), 50, 40, { width: W, align: 'right' })
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(t('N° {numero}', { numero: r.numero }), { width: W, align: 'right' }).text(t('Mandat {num}', { num: mandat?.numero ?? '' }), { width: W, align: 'right' })

  const y0 = 130
  doc.roundedRect(50, y0, W, 44, 6).fill(FOND)
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(12).text(t('Période du {debut} au {fin}', { debut: date(r.periode_debut), fin: date(r.periode_fin) }), 64, y0 + 10, { width: W - 28 })
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`${t('Statut : {statut}', { statut: t(STATUTS[r.statut] ?? r.statut) })}${r.date_validation ? ` · ${t('validé le {date}', { date: date(r.date_validation) })}` : ''}`, 64, y0 + 27)

  const y1 = y0 + 64
  doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text(t('PROPRIÉTAIRE'), 50, y1)
  doc.moveDown(0.3).font('Helvetica-Bold').fontSize(11).fillColor(TEXTE).text(nomContact(beneficiaire))
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
  for (const l of [beneficiaire?.adresse, beneficiaire?.telephone, beneficiaire?.email].filter(Boolean)) doc.text(l)

  // Lignes
  let y = y1 + 80
  doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text(t('DÉTAIL'), 50, y)
  y += 16
  doc.moveTo(50, y).lineTo(50 + W, y).strokeColor(LINE).lineWidth(1).stroke()
  y += 8
  for (const l of lignes) {
    if (y > doc.page.height - 230) { doc.addPage(); y = 60 }
    const libelle = trLigne(L, l.libelle)
    doc.font('Helvetica').fontSize(10).fillColor(TEXTE).text(libelle, 64, y, { width: W - 210 })
    const h = doc.heightOfString(libelle, { width: W - 210 })
    if (l.bien) doc.fontSize(8).fillColor(MUTED).text(l.bien, 64, y + h + 1, { width: W - 210 })
    doc.fontSize(10).fillColor(Number(l.montant) < 0 ? '#C62828' : TEXTE).text(somme(l.montant), 50 + W - 200, y, { width: 186, align: 'right' })
    y += h + (l.bien ? 16 : 8)
  }
  doc.moveTo(50, y).lineTo(50 + W, y).strokeColor(LINE).stroke()
  y += 10
  const total = (label, v, gras = false) => {
    doc.font(gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(gras ? 12 : 10).fillColor(gras ? BRAND : TEXTE)
      .text(t(label), 64, y, { width: W - 210 }).text(somme(v), 50 + W - 200, y, { width: 186, align: 'right' })
    y += gras ? 24 : 18
  }
  total('Loyers encaissés', r.montant_encaisse)
  total('Honoraires de gestion', -Number(r.montant_honoraires))
  total('Dépenses', -Number(r.montant_depenses))
  doc.moveTo(50, y - 4).lineTo(50 + W, y - 4).strokeColor(LINE).stroke()
  y += 4
  total('Net à reverser', r.montant_net, true)

  // Règlement
  y += 10
  doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text(t('RÈGLEMENT'), 50, y)
  y += 16
  const coordTexte = coord ? (coord.type === 'virement' ? `${t('Virement')} ${coord.banque ?? ''} ${masque(coord.iban_rib)}` : `${coord.operateur ?? 'Mobile Money'} ${coord.numero_mobile ?? ''}`).trim() : t('Coordonnées à préciser')
  doc.font('Helvetica').fontSize(10).fillColor(TEXTE)
    .text(r.statut === 'paye' ? t('Payé le {date} · {moyen} · réf. {ref}', { date: date(r.date_paiement), moyen: moyen?.nom ? t(moyen.nom) : '', ref: r.reference_paiement ?? '' }) : t('À verser sur : {coordonnees}', { coordonnees: coordTexte }), 64, y, { width: W - 28 })
  if (r.statut === 'paye') doc.fontSize(9).fillColor(MUTED).text(coordTexte, 64, doc.y + 2, { width: W - 28 })

  doc.page.margins.bottom = 0
  doc.fontSize(7).fillColor('#9AA8B6').text(`${t('Relevé établi par {agence} en sa qualité de mandataire de gestion (taux d’honoraires {taux} %).', { agence: agence?.nom ?? t('l’agence'), taux: Number(mandat?.taux_honoraires ?? 0).toLocaleString(L === 'en' ? 'en-GB' : 'fr-FR') })} Gocleus Immo — G-immo`, 50, doc.page.height - 45, { width: W, align: 'center' })
  doc.end()
  return { buffer: await pdfBuffer(doc), numero: r.numero }
}

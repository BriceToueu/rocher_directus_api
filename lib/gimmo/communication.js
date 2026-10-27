/**
 * G-immo — communication sortante (hook gimmo-communication et endpoint gimmo-api).
 *
 *  - rendre : modèles de messages avec variables {{prenom}}, {{montant}}… (liste VARIABLES) ;
 *  - envoyerMessage : envoie UN message « planifié » sur son canal et met à jour son statut (envoyé / échec) ;
 *      e-mail → serveur SMTP de Directus (gabarit gimmo-message, pièce jointe éventuelle : la quittance PDF) ;
 *      SMS / WhatsApp → fournisseur choisi par GIMMO_SMS_PROVIDER (« simulation » par défaut : message journalisé,
 *      référence SIM-…, aucun envoi réel) ;
 *  - traiterFile : messages planifiés arrivés à échéance + quittances à envoyer par e-mail ;
 *  - traiterAutomatisations : rappels avant échéance, relances d'impayé, fin de bail (une fois par jour, idempotent).
 * Une automatisation d'agence remplace l'automatisation par défaut (sans agence) de même déclencheur.
 */
import { randomBytes } from 'node:crypto'
import { isoDate, todayIso, dateLongue, montant, nomContact, MOIS } from './commun.js'

export const VARIABLES = {
  prenom: 'Prénom du destinataire', nom: 'Nom du destinataire', bien: 'Titre du bien', montant: 'Montant (reste dû, ou quittancé)',
  periode: 'Période (ex. octobre 2026)', date_echeance: 'Date d’échéance', date_fin: 'Date de fin du bail',
  numero_quittance: 'Numéro de quittance', agence: 'Nom de l’agence', telephone_agence: 'Téléphone de l’agence', lien: 'Lien (annonce…)',
}

/** Remplace {{variable}} par sa valeur (variables inconnues ou absentes : texte vide). */
export const rendre = (texte, vars) => String(texte ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k) => (vars[k] ?? '') === null ? '' : String(vars[k] ?? ''))

const echapper = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]))

/** Fournisseurs SMS / WhatsApp. Seule la simulation est active tant qu'aucun fournisseur n'est configuré. */
const FOURNISSEURS = {
  simulation: async ({ canal, telephone, texte }, logger) => {
    const reference = `SIM-${randomBytes(5).toString('hex').toUpperCase()}`
    logger?.info(`gimmo-communication [simulation] ${canal} → ${telephone} (${texte.length} car.) ${reference}`)
    return { reference }
  },
}

/** Envoi d'un SMS par le fournisseur configuré (GIMMO_SMS_PROVIDER, « simulation » par défaut) ; renvoie sa référence. */
export async function envoyerSms(env, telephone, texte, logger) {
  const fournisseur = FOURNISSEURS[env.GIMMO_SMS_PROVIDER || 'simulation']
  if (!fournisseur) throw new Error(`Fournisseur SMS « ${env.GIMMO_SMS_PROVIDER} » non configuré.`)
  return (await fournisseur({ canal: 'sms', telephone, texte }, logger)).reference
}

/** Variables d'un message à partir de ses liens (contact, échéance, bail, quittance, agence). */
export async function variablesDe(db, { contact, echeance, bail, quittance, agence, lien }) {
  const c = contact ? await db('contacts').where('id', contact).first('prenom', 'nom', 'raison_sociale', 'agence') : null
  const e = echeance ? await db('echeances').where('id', echeance).first('bail', 'date_echeance', 'periode_debut', 'montant_du', 'devise', 'id') : null
  const b = (bail ?? e?.bail) ? await db('baux').where('id', bail ?? e.bail).first('bien', 'date_fin', 'devise') : null
  const q = quittance ? await db('quittances').where('id', quittance).first('numero', 'montant_total', 'periode_debut', 'devise', 'bail') : null
  const bienId = b?.bien ?? (q ? (await db('baux').where('id', q.bail).first('bien'))?.bien : null)
  const bien = bienId ? await db('biens').where('id', bienId).first('titre', 'agence') : null
  const ag = await db('agences').where('id', agence ?? bien?.agence ?? c?.agence).first('nom', 'telephone')
  const devise = await db('devises').where('id', q?.devise ?? e?.devise ?? b?.devise ?? 0).first('symbole', 'decimales')
  let reste = null
  if (e) {
    const paye = Number((await db('paiements').where({ echeance: e.id, statut: 'confirme' }).sum({ s: 'montant' }).first())?.s ?? 0)
    reste = Math.max(0, Number(e.montant_du) - paye)
  }
  const debut = isoDate(q?.periode_debut ?? e?.periode_debut ?? e?.date_echeance)
  return {
    prenom: c?.prenom || nomContact(c), nom: c?.raison_sociale || c?.nom || '', bien: bien?.titre ?? '',
    montant: q ? montant(q.montant_total, devise) : reste !== null ? montant(reste, devise) : '',
    periode: debut ? `${MOIS[Number(debut.slice(5, 7)) - 1]} ${debut.slice(0, 4)}` : '',
    date_echeance: e ? dateLongue(e.date_echeance) : '', date_fin: b?.date_fin ? dateLongue(b.date_fin) : '',
    numero_quittance: q?.numero ?? '', agence: ag?.nom ?? '', telephone_agence: ag?.telephone ?? '', lien: lien ?? '',
  }
}

/** Envoie un message planifié (verrou : un seul envoi même si la file et l'endpoint le traitent en même temps). */
export async function envoyerMessage(database, id, { services, schema, env, logger }) {
  const m = await database.transaction(async (trx) => {
    const row = await trx('messages').where('id', id).forUpdate().first()
    if (!row || row.statut !== 'planifie' || row.direction !== 'sortant') return null
    await trx('messages').where('id', id).update({ statut: 'envoye', date_envoi: new Date() }) // réservé pour cet envoi
    return row
  })
  if (!m) return null
  const c = await database('contacts').where('id', m.contact).first('email', 'telephone', 'agence')
  try {
    let reference = null
    if (m.canal === 'email') {
      if (!c?.email) throw new Error('Pas d’adresse e-mail pour ce contact.')
      const vars = await variablesDe(database, { contact: m.contact, quittance: m.quittance, echeance: m.echeance, bail: m.bail })
      const attachments = []
      let pieceJointe = null
      if (m.quittance) {
        const q = await database('quittances').where('id', m.quittance).first('numero', 'fichier_pdf')
        if (q?.fichier_pdf) {
          const { stream } = await new services.AssetsService({ schema, accountability: null }).getAsset(q.fichier_pdf)
          const morceaux = []
          for await (const x of stream) morceaux.push(x)
          pieceJointe = `quittance-${q.numero}.pdf`
          attachments.push({ filename: pieceJointe, content: Buffer.concat(morceaux), contentType: 'application/pdf' })
        }
      }
      const info = await new services.MailService({ schema, knex: database }).send({
        to: c.email, subject: m.sujet || `Message de ${vars.agence || 'votre agence'}`, attachments,
        template: { name: 'gimmo-message', data: { sujet: m.sujet, corps_html: echapper(m.contenu ?? '').replace(/\n/g, '<br />'), piece_jointe: pieceJointe, agence: vars.agence, telephone_agence: vars.telephone_agence } },
      })
      reference = info?.messageId ?? null
    } else {
      if (!c?.telephone) throw new Error('Pas de numéro de téléphone pour ce contact.')
      const fournisseur = FOURNISSEURS[env.GIMMO_SMS_PROVIDER || 'simulation']
      if (!fournisseur) throw new Error(`Fournisseur SMS « ${env.GIMMO_SMS_PROVIDER} » non configuré.`)
      reference = (await fournisseur({ canal: m.canal, telephone: c.telephone, texte: m.contenu ?? '' }, logger)).reference
    }
    await database('messages').where('id', id).update({ reference_fournisseur: reference ? String(reference).slice(0, 255) : null })
    return { statut: 'envoye', reference }
  } catch (err) {
    await database('messages').where('id', id).update({ statut: 'echec', reference_fournisseur: `ERREUR : ${err.message}`.slice(0, 255) })
    logger?.warn(`gimmo-communication : message ${id} non envoyé (${err.message})`)
    return { statut: 'echec', erreur: err.message }
  }
}

/** Crée un message sortant (planifié maintenant) puis l'envoie. Les variables du modèle sont rendues à partir des liens. */
export async function creerEtEnvoyer(database, data, ctx, accountability = null) {
  const vars = await variablesDe(database, data)
  const id = await new ctx.services.ItemsService('messages', { schema: ctx.schema, knex: database, accountability }).createOne({
    contact: data.contact, canal: data.canal, direction: 'sortant', sujet: data.sujet ? rendre(data.sujet, vars) : null, contenu: rendre(data.contenu, vars),
    modele: data.modele ?? null, statut: 'planifie', date_planifiee: new Date().toISOString(), campagne: data.campagne ?? null,
    automatisation: data.automatisation ?? null, prospect: data.prospect ?? null, bail: data.bail ?? null, echeance: data.echeance ?? null, quittance: data.quittance ?? null,
  })
  return { id, ...(await envoyerMessage(database, id, ctx)) }
}

/** Automatisations effectives d'une agence : les siennes, sinon celles par défaut (sans agence), par déclencheur. */
async function automatisationsEffectives(db) {
  const toutes = await db('automatisations as a').leftJoin('modeles_messages as m', 'm.id', 'a.modele')
    .select('a.id', 'a.declencheur', 'a.decalage_jours', 'a.canaux', 'a.actif', 'a.agence', 'm.id as modele', 'm.sujet', 'm.contenu')
  const agences = await db('agences').where('actif', true).pluck('id')
  const res = []
  for (const agence of agences) {
    for (const declencheur of new Set(toutes.map(a => a.declencheur))) {
      const a = toutes.find(x => x.agence === agence && x.declencheur === declencheur) ?? toutes.find(x => !x.agence && x.declencheur === declencheur)
      if (a?.actif) res.push({ ...a, agence, canaux: typeof a.canaux === 'string' ? JSON.parse(a.canaux) : (a.canaux ?? []) })
    }
  }
  return res
}

const decaler = (iso, jours) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + jours); return d.toISOString().slice(0, 10) }
const joignable = (c, canal) => canal === 'email' ? !!c?.email : !!c?.telephone

/** Rappels et relances du jour (idempotent : un message par automatisation, cible et canal). */
export async function traiterAutomatisations(database, ctx, jour = todayIso()) {
  const bilan = { envoyes: 0, echecs: 0, ignores: 0 }
  const envoyer = async (auto, cible, lien) => {
    const c = await database('contacts').where('id', cible.contact).first('email', 'telephone')
    for (const canal of auto.canaux) {
      if (!joignable(c, canal)) { bilan.ignores++; continue }
      const deja = await database('messages').where({ automatisation: auto.id, canal, contact: cible.contact }).where(lien).first('id')
      if (deja) continue
      const r = await creerEtEnvoyer(database, { ...cible, ...lien, canal, sujet: auto.sujet, contenu: auto.contenu, modele: auto.modele, automatisation: auto.id }, ctx)
      r.statut === 'envoye' ? bilan.envoyes++ : bilan.echecs++
    }
  }
  for (const auto of await automatisationsEffectives(database)) {
    const d = Number(auto.decalage_jours ?? 0)
    if (auto.declencheur === 'avant_echeance' || auto.declencheur === 'apres_impaye') {
      const date = auto.declencheur === 'avant_echeance' ? decaler(jour, d) : decaler(jour, -d)
      const statuts = auto.declencheur === 'avant_echeance' ? ['a_venir', 'en_attente'] : ['en_attente', 'partiel', 'en_retard']
      const ech = await database('echeances as e').join('baux as b', 'b.id', 'e.bail').where('e.agence', auto.agence).where('e.date_echeance', date)
        .whereIn('e.statut', statuts).whereIn('b.statut', ['en_vigueur', 'litige']).select('e.id', 'e.bail', 'b.locataire')
      for (const e of ech) await envoyer(auto, { contact: e.locataire, agence: auto.agence }, { echeance: e.id })
    } else if (auto.declencheur === 'avant_fin_bail') {
      const baux = await database('baux as b').join('biens as bi', 'bi.id', 'b.bien').where('bi.agence', auto.agence).where('b.statut', 'en_vigueur')
        .where('b.date_fin', decaler(jour, d)).select('b.id', 'b.locataire')
      for (const b of baux) await envoyer(auto, { contact: b.locataire, agence: auto.agence }, { bail: b.id })
    }
  }
  return bilan
}

/** File : messages planifiés échus, puis quittances récentes à envoyer par e-mail (automatisation « paiement confirmé »). */
export async function traiterFile(database, ctx) {
  const bilan = { envoyes: 0, echecs: 0 }
  const dus = await database('messages').where({ statut: 'planifie', direction: 'sortant' }).where('date_planifiee', '<=', new Date()).limit(100).pluck('id')
  for (const id of dus) { const r = await envoyerMessage(database, id, ctx); if (r) r.statut === 'envoye' ? bilan.envoyes++ : bilan.echecs++ }

  const autos = (await automatisationsEffectives(database)).filter(a => a.declencheur === 'paiement_confirme')
  for (const auto of autos) {
    const quittances = await database('quittances as q').join('baux as b', 'b.id', 'q.bail').join('biens as bi', 'bi.id', 'b.bien')
      .where('bi.agence', auto.agence).where('q.statut', 'emise').whereNull('q.date_envoi').whereNotNull('q.fichier_pdf')
      .where('q.date_emission', '>=', decaler(todayIso(), -2)).select('q.id', 'b.locataire').limit(50)
    for (const q of quittances) {
      const c = await database('contacts').where('id', q.locataire).first('email')
      if (!c?.email || !auto.canaux.includes('email')) { await database('quittances').where('id', q.id).update({ date_envoi: new Date() }); continue }
      const r = await creerEtEnvoyer(database, { contact: q.locataire, quittance: q.id, canal: 'email', sujet: auto.sujet, contenu: auto.contenu, modele: auto.modele, automatisation: auto.id, agence: auto.agence }, ctx)
      await database('quittances').where('id', q.id).update({ date_envoi: new Date(), ...(r.statut === 'envoye' ? { statut: 'envoyee' } : {}) })
      r.statut === 'envoye' ? bilan.envoyes++ : bilan.echecs++
    }
  }
  return bilan
}

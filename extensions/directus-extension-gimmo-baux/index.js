/**
 * G-immo — cycle de vie des baux (s'applique au Data Studio, à l'API et au front).
 *
 * Avant écriture (filtre, même transaction que le bail) :
 *  - référence BAIL-AAAA-NNNN si absente ;
 *  - date de fin calculée à partir de la date de début et de la durée (si non fournie) ;
 *  - devise par défaut : celle du pays de l'agence du bien ;
 *  - date de fin ≥ date de début ; un seul bail en vigueur (ou en litige) par bien ;
 *  - bail en vigueur → échéances mensuelles manquantes ajoutées (relation O2M `echeances`) ;
 *  - bail résilié / terminé → échéances non réglées postérieures à la fin annulées.
 * Après écriture (action, filet de sécurité idempotent) :
 *  - mêmes échéances si le filtre n'a pas pu les traiter (modification groupée) ;
 *  - statut du bien : « loué » s'il a un bail en vigueur ou en litige, sinon « disponible ».
 *
 * Le bien n'est jamais modifié via le payload du bail : la règle de cohérence d'agence
 * (extension gimmo-rules) doit toujours voir `bien` comme un identifiant.
 */
import { createError } from '@directus/errors'
import { statutImpaye } from '../../lib/gimmo/loyers.js'

const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const fail = (message) => { throw new BusinessRuleError({ message }) }

const ACTIF = 'en_vigueur'
const OCCUPE = [ACTIF, 'litige'] // le locataire occupe le bien : bien « loué », pas de second bail
const CLOS = ['resilie', 'termine']
const NON_REGLEES = ['a_venir', 'en_attente', 'en_retard']
const HORIZON_INDETERMINE = 12 // bail à durée indéterminée : échéances générées 12 mois à l'avance (glissant)
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
/** Colonne date → Date UTC à minuit. Le pilote pg renvoie un Date à minuit local, l'API une chaîne AAAA-MM-JJ. */
const parse = (v) => {
  if (v instanceof Date) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()))
  const [y, m, d] = String(v).slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
const todayIso = () => iso(parse(new Date()))
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
/** Ajoute des mois en restant dans le mois cible (31 janvier + 1 mois = 28/29 février). */
function addMonths(date, months) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1))
  target.setUTCDate(Math.min(date.getUTCDate(), lastDayOfMonth(target.getUTCFullYear(), target.getUTCMonth())))
  return target
}

async function nextReference(db, annee) {
  const last = await db('baux').where('reference', 'like', `BAIL-${annee}-%`).orderBy('reference', 'desc').first('reference')
  const n = last ? Number(last.reference.split('-')[2]) + 1 : 1
  return `BAIL-${annee}-${String(n).padStart(4, '0')}`
}

/** Échéances mensuelles manquantes d'un bail (sans le champ `bail`, ajouté par la relation ou par l'appelant). */
async function echeancesManquantes(db, bail) {
  const debut = parse(bail.date_debut)
  const debutMoisCourant = parse(todayIso().slice(0, 8) + '01')
  const fin = bail.date_fin ? parse(bail.date_fin) : addMonths(debut > debutMoisCourant ? debut : debutMoisCourant, HORIZON_INDETERMINE)
  const bien = await db('biens').select('agence').where('id', bail.bien).first()
  const existantes = bail.id
    ? new Set((await db('echeances').where('bail', bail.id).pluck('periode_debut')).map(d => iso(parse(d))))
    : new Set()
  const loyer = Number(bail.loyer_hors_charges)
  const charges = Number(bail.provision_charges ?? 0)
  const jour = Number(bail.jour_echeance ?? 1)
  const today = todayIso()
  const lignes = []
  for (let mois = new Date(Date.UTC(debut.getUTCFullYear(), debut.getUTCMonth(), 1)); mois < fin; mois = addMonths(mois, 1)) {
    const y = mois.getUTCFullYear(), m = mois.getUTCMonth()
    // première période à partir de la date de début ; dernière jusqu'à la veille de la date de fin
    const pDebut = mois < debut ? debut : mois
    const finMois = new Date(Date.UTC(y, m, lastDayOfMonth(y, m)))
    const pFin = fin <= finMois ? new Date(fin.getTime() - 86400000) : finMois
    if (pFin < pDebut) continue
    const periodeDebut = iso(pDebut)
    if (existantes.has(periodeDebut)) continue
    const echeance = new Date(Date.UTC(y, m, Math.min(jour, lastDayOfMonth(y, m))))
    const dateEcheance = iso(echeance < pDebut ? pDebut : echeance)
    lignes.push({
      libelle: `Loyer ${MOIS[m]} ${y}`, periode_debut: periodeDebut, periode_fin: iso(pFin),
      date_echeance: dateEcheance, montant_du: loyer + charges, montant_loyer: loyer, montant_charges: charges,
      devise: bail.devise, statut: statutImpaye(dateEcheance, 0, today), agence: bien?.agence,
    })
  }
  return lignes
}

/** Échéances non réglées d'un bail clos dont la période commence après sa fin. */
async function echeancesAAnnuler(db, bail) {
  const limite = iso(parse(bail.date_fin ?? new Date()))
  return db('echeances').where('bail', bail.id).where('periode_debut', '>', limite).whereIn('statut', NON_REGLEES).pluck('id')
}

async function syncStatutBien(db, bienId) {
  const actif = await db('baux').where('bien', bienId).whereIn('statut', OCCUPE).first('id')
  const bien = await db('biens').select('statut').where('id', bienId).first()
  if (!bien) return
  if (actif && bien.statut !== 'loue') await db('biens').where('id', bienId).update({ statut: 'loue' })
  if (!actif && bien.statut === 'loue') await db('biens').where('id', bienId).update({ statut: 'disponible' })
}

export default ({ filter, action, schedule }, { services, database: db0, getSchema }) => {
  const { ItemsService } = services

  /** Contrôles et valeurs dérivées ; renvoie la ligne finale (existant + payload). */
  const prepare = async (payload, existing, db) => {
    const row = { ...(existing ?? {}), ...payload }
    const dureeChange = 'duree_mois' in payload || 'date_debut' in payload
    if (row.date_debut && row.duree_mois && dureeChange && !('date_fin' in payload)) {
      payload.date_fin = iso(addMonths(parse(row.date_debut), Number(row.duree_mois)))
      row.date_fin = payload.date_fin
    }
    if (row.date_debut && row.date_fin && parse(row.date_fin) < parse(row.date_debut)) fail('La date de fin du bail doit être postérieure à la date de début.')
    if (!row.devise && row.bien) {
      const d = await db('biens as b').join('agences as a', 'a.id', 'b.agence').join('pays as p', 'p.id', 'a.pays').where('b.id', row.bien).first('p.devise')
      if (d?.devise) { payload.devise = d.devise; row.devise = d.devise }
    }
    if (OCCUPE.includes(row.statut) && row.bien) {
      const autre = await db('baux').where('bien', row.bien).whereIn('statut', OCCUPE).modify(q => { if (row.id) q.whereNot('id', row.id) }).first('reference')
      if (autre) fail(`Ce bien a déjà un bail en vigueur (${autre.reference ?? 'sans référence'}). Résiliez-le ou terminez-le d’abord.`)
    }
    return row
  }

  filter('baux.items.create', async (payload, _meta, { database }) => {
    if (!payload.reference) payload.reference = await nextReference(database, new Date().getFullYear())
    const row = await prepare(payload, null, database)
    if (row.statut === ACTIF && row.date_debut && !payload.echeances) payload.echeances = await echeancesManquantes(database, row)
    return payload
  })

  filter('baux.items.update', async (payload, meta, { database }) => {
    const rows = []
    for (const id of meta.keys) rows.push(await prepare(payload, await database('baux').where('id', id).first(), database))
    // un seul bail modifié : échéances traitées dans la même transaction ; sinon par l'action
    if (rows.length === 1 && !payload.echeances) {
      const row = rows[0]
      if (row.statut === ACTIF) {
        const create = await echeancesManquantes(database, row)
        if (create.length) payload.echeances = { create, update: [], delete: [] }
      } else if (CLOS.includes(row.statut)) {
        const ids = await echeancesAAnnuler(database, row)
        if (ids.length) payload.echeances = { create: [], update: ids.map(id => ({ id, statut: 'annulee' })), delete: [] }
      }
    }
    return payload
  })

  const afterWrite = async (ids, { database, schema }) => {
    for (const id of ids) {
      const bail = await database('baux').where('id', id).first()
      if (!bail) continue
      if (bail.statut === ACTIF) {
        const lignes = await echeancesManquantes(database, bail)
        if (lignes.length) await new ItemsService('echeances', { schema, knex: database }).createMany(lignes.map(l => ({ ...l, bail: id })))
      }
      if (CLOS.includes(bail.statut)) {
        const aAnnuler = await echeancesAAnnuler(database, bail)
        if (aAnnuler.length) await database('echeances').whereIn('id', aAnnuler).update({ statut: 'annulee' })
      }
      await syncStatutBien(database, bail.bien)
    }
  }
  action('baux.items.create', (meta, context) => afterWrite([meta.key], context))
  // Chaque nuit : prolonge l'échéancier glissant des baux sans terme
  schedule('30 0 * * *', async () => {
    const schema = await getSchema()
    const ids = await db0('baux').where('statut', ACTIF).whereNull('date_fin').pluck('id')
    await afterWrite(ids, { database: db0, schema })
  })
  action('baux.items.update', (meta, context) => afterWrite(meta.keys, context))
}

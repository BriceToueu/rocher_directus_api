/**
 * G-immo — promotion immobilière : programmes, lots et ventes de lots (Data Studio, API, front).
 *
 * Programmes : adresse web (slug) unique tirée du nom ; avancement 0–100 % ; latitude et longitude renseignées ensemble
 *   et plausibles ; publication : image principale obligatoire.
 * Lots : devise du pays de l'agence ; prix positif ; référence unique dans le programme ; zone sur le plan de masse
 *   valide (au moins 3 points [x, y] compris entre 0 et 1).
 * Ventes de lots : référence VTE-AAAA-NNNNN ; agence et devise reprises du programme ; un lot déjà réservé ou vendu
 *   ne peut pas faire l'objet d'une nouvelle vente ; le statut du lot suit la vente
 *   (réservation → réservé, contrat / acte / livraison → vendu, annulation → disponible).
 */
import { createError } from '@directus/errors'

const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const fail = (message) => { throw new BusinessRuleError({ message }) }

const slugifier = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'programme'
const VENTE_LOT = { reservation: 'reserve', contrat_signe: 'vendu', acte_authentique: 'vendu', livree: 'vendu' }
const PHASES = ['pre_vente', 'construction', 'livraison', 'livre']
const VENTES_ACTIVES = Object.keys(VENTE_LOT)

export default ({ filter, action }) => {
  // événements génériques : vus avant les contrôles génériques de gimmo-rules (voir gimmo-gestion)
  const pour = (collection, act, handler) => filter(`items.${act}`, (payload, meta, context) => meta.collection === collection ? handler(payload, meta, context) : payload)

  // ── Programmes
  async function controlerProgramme(db, payload, existing) {
    const row = { ...(existing ?? {}), ...payload }
    if (!existing && !payload.slug) payload.slug = payload.nom // adresse web tirée du nom à la création
    if (payload.slug !== undefined) {
      let base = slugifier(payload.slug), slug = base, i = 2
      while (await db('programmes').where('slug', slug).modify(q => { if (existing?.id) q.whereNot('id', existing.id) }).first('id')) slug = `${base}-${i++}`
      payload.slug = slug
    }
    if ('phase' in payload && payload.phase !== null && !PHASES.includes(payload.phase)) fail('Phase du programme inconnue.')
    const av = Number(row.avancement_travaux ?? 0)
    if (!Number.isInteger(av) || av < 0 || av > 100) fail('L’avancement des travaux doit être compris entre 0 et 100 %.')
    // emprise (contour sur la carte) : 1 à 10 parcelles de 3 à 200 sommets ; le repère est placé au centre du contour
    if ('emprise' in payload && payload.emprise !== null) {
      let z = payload.emprise
      if (typeof z === 'string') { try { z = JSON.parse(z) } catch { fail('Contour du programme invalide.') } }
      const point = (c) => Array.isArray(c) && c.length === 2 && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1])) && Math.abs(Number(c[0])) <= 90 && Math.abs(Number(c[1])) <= 180
      if (!Array.isArray(z) || z.length < 1 || z.length > 10 || !z.every(p => Array.isArray(p) && p.length >= 3 && p.length <= 200 && p.every(point))) {
        fail('Le contour du programme doit compter 1 à 10 parcelles de 3 à 200 sommets, aux coordonnées valides.')
      }
      payload.emprise = z.map(p => p.map(([a, b]) => [Math.round(Number(a) * 1e6) / 1e6, Math.round(Number(b) * 1e6) / 1e6]))
      if (!('latitude' in payload) || payload.latitude === null || payload.latitude === '') {
        const tous = payload.emprise.flat()
        payload.latitude = Math.round(tous.reduce((s, c) => s + c[0], 0) / tous.length * 1e6) / 1e6
        payload.longitude = Math.round(tous.reduce((s, c) => s + c[1], 0) / tous.length * 1e6) / 1e6
        row.latitude = payload.latitude; row.longitude = payload.longitude
      }
    }
    const lat = row.latitude, lng = row.longitude
    const vide = (v) => v === null || v === undefined || v === ''
    if (vide(lat) !== vide(lng)) fail('Renseignez la latitude et la longitude ensemble (ou aucune des deux).')
    if (!vide(lat) && (Math.abs(Number(lat)) > 90 || Math.abs(Number(lng)) > 180)) fail('Coordonnées GPS invalides.')
    if (row.statut_publication === 'publie' && existing?.statut_publication !== 'publie' && !row.image_principale) fail('Ajoutez une image principale avant de publier le programme.')
    return payload
  }
  pour('programmes', 'create', async (payload, _meta, { database }) => controlerProgramme(database, payload, null))
  pour('programmes', 'update', async (payload, meta, { database }) => {
    for (const id of meta.keys) await controlerProgramme(database, payload, await database('programmes').where('id', id).first())
    return payload
  })

  // ── Lots
  function controlerZone(zone) {
    if (zone === null || zone === undefined) return
    const pts = typeof zone === 'string' ? JSON.parse(zone) : zone
    if (!Array.isArray(pts) || pts.length < 3 || !pts.every(p => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && v >= 0 && v <= 1))) {
      fail('La zone du lot sur le plan de masse doit compter au moins 3 points compris dans l’image.')
    }
  }
  async function controlerLot(db, payload, existing) {
    const row = { ...(existing ?? {}), ...payload }
    if ('prix' in payload && !(Number(payload.prix) > 0)) fail('Le prix du lot doit être positif.')
    if ('zone_plan' in payload) controlerZone(payload.zone_plan)
    if (row.programme && (!existing || 'programme' in payload) && !row.devise) {
      const d = await db('programmes as p').join('agences as a', 'a.id', 'p.agence').join('pays as py', 'py.id', 'a.pays').where('p.id', row.programme).first('py.devise')
      if (d?.devise) payload.devise = d.devise
    }
    if (row.programme && row.reference && ('reference' in payload || 'programme' in payload)) {
      const doublon = await db('lots').where({ programme: row.programme, reference: row.reference }).modify(q => { if (existing?.id) q.whereNot('id', existing.id) }).first('id')
      if (doublon) fail(`Un lot « ${row.reference} » existe déjà dans ce programme.`)
    }
    return payload
  }
  pour('lots', 'create', async (payload, _meta, { database }) => controlerLot(database, payload, null))
  pour('lots', 'update', async (payload, meta, { database }) => {
    for (const id of meta.keys) await controlerLot(database, payload, await database('lots').where('id', id).first())
    return payload
  })

  // ── Ventes de lots
  pour('ventes', 'create', async (payload, _meta, { database }) => {
    if (!payload.reference) {
      const annee = new Date().getFullYear()
      const last = await database('ventes').where('reference', 'like', `VTE-${annee}-%`).orderBy('reference', 'desc').first('reference')
      payload.reference = `VTE-${annee}-${String(last ? Number(last.reference.split('-')[2]) + 1 : 1).padStart(5, '0')}`
    }
    if ('prix_vente' in payload && !(Number(payload.prix_vente) > 0)) fail('Le prix de vente doit être positif.')
    if (typeof payload.lot === 'string') {
      const lot = await database('lots as l').join('programmes as p', 'p.id', 'l.programme').where('l.id', payload.lot).first('l.statut', 'l.reference', 'l.devise', 'l.prix', 'p.agence')
      if (!lot) fail('Lot introuvable.')
      if (lot.statut !== 'disponible') fail(`Le lot ${lot.reference} n’est pas disponible (${lot.statut === 'reserve' ? 'déjà réservé' : lot.statut === 'vendu' ? 'déjà vendu' : 'bloqué'}).`)
      payload.agence ??= lot.agence
      payload.devise ??= lot.devise
      payload.prix_vente ??= lot.prix
      payload.statut ??= 'reservation'
      if (payload.statut === 'reservation') payload.date_reservation ??= new Date().toISOString().slice(0, 10)
    }
    return payload
  })

  // le statut du lot suit la vente la plus avancée encore active
  const synchroniser = async (ids, { database }) => {
    const lots = await database('ventes').whereIn('id', ids).whereNotNull('lot').pluck('lot')
    for (const lot of new Set(lots)) {
      const actives = await database('ventes').where('lot', lot).whereIn('statut', VENTES_ACTIVES).pluck('statut')
      const statut = actives.some(s => VENTE_LOT[s] === 'vendu') ? 'vendu' : actives.length ? 'reserve' : 'disponible'
      await database('lots').where('id', lot).whereNot('statut', 'bloque').update({ statut })
    }
  }
  action('ventes.items.create', (meta, ctx) => synchroniser([meta.key], ctx))
  action('ventes.items.update', (meta, ctx) => synchroniser(meta.keys, ctx))
}


import { describe,it,expect } from 'vitest'
import { mediaMovementFixture } from './reporting-browser/media-movement-fixture'
import { deriveMediaMovement } from '@/lib/reporting/review/media-movement'
import { derivePerformanceReview } from '@/lib/reporting/review/performance'
import { mediaEntityFields } from '@/lib/reporting/review/business-platform-evidence'
import { buildMetaMetrics } from '@/lib/reporting/meta-metrics'
import { projectCampaignAuthority } from '@/lib/reporting/meta-campaign-authority'
import { validateReportingPacket } from '@/lib/reporting/validation'
const raw=(spend=100,count=2,value=200)=>({spend:String(spend),impressions:'1000',results:[{indicator:'AppointmentConfirmed',values:[{value:String(count),attribution_windows:['default']}]}],conversion_values:[{action_type:'AppointmentConfirmed',value:String(value)}],actions:[{action_type:'purchase',value:'1'}],action_values:[{action_type:'purchase',value:'100'}]})
describe('Media result regression controls',()=>{
 it('classifies volume/value decline independently of withheld ROAS',()=>{
  const data=mediaMovementFixture();const row=data.meta.data!.entities.find(e=>e.id==='lower')!
  row.metrics=structuredClone(buildMetaMetrics(data.context,raw(100,2,200),raw(100,3,300),{level:row.level,id:row.id}))
  for(const period of ['current','previous'] as const){const claim=row.metrics.appointment_roas[period]!;claim.value=null;claim.availability={state:'unavailable',blockerCodes:['meta_outcome_hierarchy_unreconciled']};claim.coverage={state:'unknown',numerator:null,denominator:null}}
  const result=derivePerformanceReview(data).findings.find(f=>f.id==='performance:campaign:lower')!
  const fields=mediaEntityFields(data,data.meta.data!.entities.indexOf(row))
  expect(fields.bookings.change).toBe(-1);expect(fields.appointment_value.change).toBe(-100);expect(result.direction).toBe('declined')
 })
 it('does not call an unreconciled changing account unchanged',()=>{
  const data=mediaMovementFixture();const report=data.meta.data!
  for(const entity of report.entities) entity.metrics=buildMetaMetrics(data.context,raw(),raw(),{level:entity.level,id:entity.id})
  report.metrics=buildMetaMetrics(data.context,raw(350,6,600),raw(300,6,600))
  data.meta.data=projectCampaignAuthority(data.context,report,new Map(['current','previous'].map(p=>[`${p}:campaign`,report.entities.filter(e=>e.level==='campaign').map(e=>({campaign_id:e.id}))]))).report
  validateReportingPacket({context:data.context,section:'meta',result:data.meta,notes:[]})
  const result=deriveMediaMovement(data)
  expect(result.observation.text).toContain('unresolved account difference +$50');expect(result.status).toBe('mixed')
 })
 it('retains qualified partial observations without signed changes',()=>{
  const data=mediaMovementFixture('2026-08-20','2026-08-22',undefined,'2026-08-22T16:00:00Z')
  const result=deriveMediaMovement(data)
  expect(result.observation.text).toContain('current $950 (3/3 campaigns) [partial period]')
  expect(result.observation.text).not.toContain('net -$80')
  expect(result.counterEvidence.text).toContain('partial period')
 })
 it('keeps the earlier provisional decline when later reported outcomes remove it',()=>{
  const early=mediaMovementFixture('2026-08-20','2026-08-22',undefined,'2026-08-23T16:00:00Z')
  const earlier=early.meta.data!.entities.find(row=>row.id==='lower')!
  earlier.metrics=buildMetaMetrics(early.context,raw(100,2,200),raw(100,3,300),{level:earlier.level,id:earlier.id})
  const first=derivePerformanceReview(early).findings.find(row=>row.id==='performance:campaign:lower')!
  const original=JSON.stringify(first)
  expect(first.direction).toBe('declined');expect(first.observation.text).toContain('provisional')
  const late=mediaMovementFixture(), later=late.meta.data!.entities.find(row=>row.id==='lower')!
  later.metrics=buildMetaMetrics(late.context,raw(100,3,300),raw(100,3,300),{level:later.level,id:later.id})
  const second=derivePerformanceReview(late).findings.find(row=>row.id==='performance:campaign:lower')!
  expect(second.direction).toBeUndefined();expect(second.observation.text).not.toContain('provisional')
  expect(JSON.stringify(first)).toBe(original)
 })

})

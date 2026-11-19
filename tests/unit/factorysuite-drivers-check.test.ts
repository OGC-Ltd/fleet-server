import { describe, it, expect } from 'vitest'
import { summariseDrivers } from '../../src/modules/iam/factorysuite-drivers-check.js'

// Made-up rows in the register's shape
const rows = [
  { id: 'a', factoryCode: 'MUFINDI PAPER MILLS', driverType: 'TRACTOR', name: 'A One', idNumber: '123', phoneNumber: '0700', active: true },
  { id: 'b', factoryCode: 'MUFINDI PAPER MILLS', driverType: 'TRUCK', name: 'B Two', idNumber: null, phoneNumber: '', active: false },
  { id: 'c', factoryCode: 'NDHIWA', driverType: 'TRACTOR', name: 'C Three', photoUrls: [], status: 'ACTIVE' },
]

describe('summariseDrivers', () => {
  it('counts drivers by factory code and type, and the active ones', () => {
    const s = summariseDrivers(rows, null)
    expect(s).toMatchObject({ total: 3, active: 2, byFactoryCode: { 'MUFINDI PAPER MILLS': 2, NDHIWA: 1 }, byType: { TRACTOR: 2, TRUCK: 1 } })
  })

  it('lists every field with how many rows fill it, and no values', () => {
    const s = summariseDrivers(rows, 'MUFINDI PAPER MILLS')
    expect(s.fields).toMatchObject({ id: 3, name: 3, idNumber: 1, phoneNumber: 1, photoUrls: 0 })
    expect(JSON.stringify(s)).not.toMatch(/A One|0700|123/)
    expect(s.factoryCode).toBe('MUFINDI PAPER MILLS')
  })

  it('handles an empty register', () => {
    expect(summariseDrivers([], 'X')).toEqual({ factoryCode: 'X', total: 0, active: 0, byFactoryCode: {}, byType: {}, fields: {} })
  })
})

import { describe, expect, it } from 'vitest';
import { isProbeSafeColumn } from './value-probe.js';

const col = (name: string, type = 'varchar') => ({ name, type });

describe('value-probe deny policy', () => {
  it('denies secrets', () => {
    for (const n of ['password', 'api_key', 'session_token', 'auth_hash', 'privateKey', 'otp_code']) {
      expect(isProbeSafeColumn(col(n)), n).toBe(false);
    }
  });

  it('denies payment and banking identifiers', () => {
    // A probe returns literal values, so one match is the leak.
    for (const n of ['credit_card_number', 'card_number', 'cvv', 'iban', 'routing_number', 'account_number', 'sort_code']) {
      expect(isProbeSafeColumn(col(n)), n).toBe(false);
    }
  });

  it('denies government and identity documents', () => {
    for (const n of ['ssn', 'passport_number', 'tax_id', 'national_id', 'driver_license', 'aadhaar_number']) {
      expect(isProbeSafeColumn(col(n)), n).toBe(false);
    }
  });

  it('denies contact and location fields', () => {
    for (const n of ['home_address', 'street_name', 'postal_code', 'zip_code', 'phone_number', 'mobile_number', 'latitude']) {
      expect(isProbeSafeColumn(col(n)), n).toBe(false);
    }
  });

  it('denies health, compensation and protected attributes', () => {
    for (const n of ['diagnosis_code', 'patient_name', 'salary_band', 'payroll_id', 'ethnicity', 'religion_name']) {
      expect(isProbeSafeColumn(col(n)), n).toBe(false);
    }
  });

  it('denies free text, whose shape gives no safety', () => {
    for (const n of ['notes', 'comment', 'description', 'message_body', 'feedback_text']) {
      expect(isProbeSafeColumn(col(n)), n).toBe(false);
    }
  });

  it('still ALLOWS the ordinary business identifiers a probe exists for', () => {
    // A deny-list that blocks everything makes member binding impossible, which
    // is the defect the probe was built to fix.
    for (const n of ['customer_name', 'product_name', 'supply_name', 'category_name', 'segment_label']) {
      expect(isProbeSafeColumn(col(n)), n).toBe(true);
    }
  });

  it('still requires an identifier-shaped name and a textual type', () => {
    expect(isProbeSafeColumn(col('revenue', 'double'))).toBe(false);
    expect(isProbeSafeColumn(col('customer_name', 'double'))).toBe(false);
  });
});

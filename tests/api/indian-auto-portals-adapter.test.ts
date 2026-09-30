import { describe, expect, it } from 'vitest';
import { normalizeCarWaleLead, parseCarWaleLead } from '../../src/lib/providers/carwale-adapter';
import { normalizeCarDekhoLead, parseCarDekhoLead } from '../../src/lib/providers/cardekho-adapter';
import { normalizeJustdialLead, parseJustdialLead } from '../../src/lib/providers/justdial-adapter';

describe('Indian Auto Portals Lead Adapters', () => {
  describe('CarWale Adapter', () => {
    it('parses and normalizes CarWale buyer enquiry payload', () => {
      const payload = {
        LeadId: 'CW-ENQ-9912',
        CustomerName: 'Rajesh Sharma',
        CustomerPhone: '9876543210',
        CustomerEmail: 'rajesh.sharma@example.com',
        City: 'Bengaluru',
        State: 'Karnataka',
        CarName: 'Tata Safari Dark Edition',
        Budget: '22-25 Lakhs',
        Comments: 'Looking for immediate delivery and exchange offer for existing car.',
      };

      const envelope = parseCarWaleLead(payload);
      expect(envelope).toMatchObject({
        leadId: 'CW-ENQ-9912',
        customerName: 'Rajesh Sharma',
        phone: '+919876543210',
        email: 'rajesh.sharma@example.com',
        location: 'Bengaluru, Karnataka',
        interestedModel: 'Tata Safari Dark Edition',
        budget: '22-25 Lakhs',
      });

      const lead = normalizeCarWaleLead(envelope);
      expect(lead).toEqual({
        source: 'CarWale',
        customerName: 'Rajesh Sharma',
        phone: '+919876543210',
        email: 'rajesh.sharma@example.com',
        location: 'Bengaluru, Karnataka',
        interestedModel: 'Tata Safari Dark Edition',
        sourceDetail:
          'CarWale: Comments: Looking for immediate delivery and exchange offer for existing car. | Budget: 22-25 Lakhs',
        externalLeadId: 'CW-ENQ-9912',
      });
    });

    it('throws when minimum required identity fields are missing', () => {
      expect(() => parseCarWaleLead({ LeadId: '123' })).toThrow(
        'CARWALE_LEAD_MINIMUM_FIELDS_MISSING',
      );
    });
  });

  describe('CarDekho Adapter', () => {
    it('parses and normalizes CarDekho buyer lead payload', () => {
      const payload = {
        lead_id: 'CD-LEAD-5521',
        name: 'Pooja Hegde',
        mobile: '09812345678',
        email: 'pooja.h@example.com',
        city: 'Mumbai',
        state: 'Maharashtra',
        model: 'Mahindra XUV700 AX7',
        buyer_budget: '25 Lakhs',
        remarks: 'Interested in automatic diesel variant test drive at home.',
      };

      const envelope = parseCarDekhoLead(payload);
      expect(envelope).toMatchObject({
        leadId: 'CD-LEAD-5521',
        customerName: 'Pooja Hegde',
        phone: '+919812345678',
        email: 'pooja.h@example.com',
        location: 'Mumbai, Maharashtra',
        interestedModel: 'Mahindra XUV700 AX7',
      });

      const lead = normalizeCarDekhoLead(envelope);
      expect(lead).toEqual({
        source: 'CarDekho',
        customerName: 'Pooja Hegde',
        phone: '+919812345678',
        email: 'pooja.h@example.com',
        location: 'Mumbai, Maharashtra',
        interestedModel: 'Mahindra XUV700 AX7',
        sourceDetail:
          'CarDekho: Remarks: Interested in automatic diesel variant test drive at home. | Budget: 25 Lakhs',
        externalLeadId: 'CD-LEAD-5521',
      });
    });

    it('throws when customer name or mobile is absent', () => {
      expect(() => parseCarDekhoLead({ model: 'Creta' })).toThrow(
        'CARDEKHO_LEAD_MINIMUM_FIELDS_MISSING',
      );
    });
  });

  describe('Justdial Adapter', () => {
    it('parses and normalizes Justdial verified lead payload', () => {
      const payload = {
        leadid: 'JD-QUERY-7744',
        name: 'Vikas Verma',
        mobile: '9777123456',
        email: 'vikas.verma@example.com',
        area: 'Indiranagar',
        city: 'Bengaluru',
        state: 'Karnataka',
        category: 'New Car Dealers - Hyundai',
        message: 'Looking for Creta SX (O) Turbo Petrol quote',
      };

      const envelope = parseJustdialLead(payload);
      expect(envelope).toMatchObject({
        leadId: 'JD-QUERY-7744',
        customerName: 'Vikas Verma',
        phone: '+919777123456',
        email: 'vikas.verma@example.com',
        location: 'Indiranagar, Bengaluru, Karnataka',
        category: 'New Car Dealers - Hyundai',
      });

      const lead = normalizeJustdialLead(envelope);
      expect(lead).toEqual({
        source: 'Justdial',
        customerName: 'Vikas Verma',
        phone: '+919777123456',
        email: 'vikas.verma@example.com',
        location: 'Indiranagar, Bengaluru, Karnataka',
        interestedModel: 'New Car Dealers - Hyundai',
        sourceDetail:
          'Justdial: Category: New Car Dealers - Hyundai | Details: Looking for Creta SX (O) Turbo Petrol quote',
        externalLeadId: 'JD-QUERY-7744',
      });
    });

    it('throws when mandatory name or phone is absent', () => {
      expect(() => parseJustdialLead({ category: 'Car Dealer' })).toThrow(
        'JUSTDIAL_LEAD_MINIMUM_FIELDS_MISSING',
      );
    });
  });
});

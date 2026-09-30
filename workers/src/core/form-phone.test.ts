import { describe, expect, it } from 'vitest';
import { phoneFromFormText } from './form-phone.js';

// Verbatim inbound bodies from The Bot Crew's lead form (2026-09-30).
const INSTAGRAM_FORM = `Hello! I filled out your form and would like to know more about your business.
Full name: Antonio Salceda
WhatsApp number: +526618505089
¿Cuál es tu rol en el negocio?: Soy el dueño / la dueña
¿Cuántas personas nuevas te escriben por WhatsApp a la semana?: Menos de 10
¿Quién contesta el WhatsApp del negocio hoy?: Yo, desde mi celular
¿Qué tipo de negocio tienes?: Spa
De los mensajes que llegan a WA, ¿cuántos crees que se queden sin contestar o los contestas tarde?: 3`;

const FACEBOOK_FORM = `Hello! I filled out your form and would like to know more about your business.
¿Qué tipo de negocio tienes?: Bellesa
¿Cuántas personas nuevas te escriben por WhatsApp a la semana?: Más de 30
WhatsApp number: +526632004242
De los mensajes que llegan a WA, ¿cuántos crees que se queden sin contestar o los contestas tarde?: Algunos
Full name: Ivann Dupri
¿Cuál es tu rol en el negocio?: Trabajo ahí, pero no tomo las decisiones
¿Quién contesta el WhatsApp del negocio hoy?: Varias personas, sin un orden fijo`;

describe('phoneFromFormText', () => {
  it('reads the WhatsApp number from an Instagram lead-form message', () => {
    expect(phoneFromFormText(INSTAGRAM_FORM)).toBe('+526618505089');
  });

  it('reads it wherever the field lands in the form order', () => {
    expect(phoneFromFormText(FACEBOOK_FORM)).toBe('+526632004242');
  });

  it('accepts other phone labels and strips formatting', () => {
    expect(phoneFromFormText('Phone number: +52 (664) 385-0341')).toBe('+526643850341');
    expect(phoneFromFormText('Número de teléfono: +1 619 555 0100')).toBe('+16195550100');
    expect(phoneFromFormText('Celular: +526641234567')).toBe('+526641234567');
  });

  it('ignores a question that mentions WhatsApp but answers with no number', () => {
    expect(phoneFromFormText('¿Cuántas personas nuevas te escriben por WhatsApp a la semana?: Más de 30')).toBeUndefined();
  });

  it('does not guess a country code for a bare local number', () => {
    expect(phoneFromFormText('WhatsApp number: 6618505089')).toBeUndefined();
  });

  it('ignores a number typed outside a labelled line', () => {
    expect(phoneFromFormText('hola, mi whatsapp es +526618505089')).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(phoneFromFormText('')).toBeUndefined();
    expect(phoneFromFormText(undefined)).toBeUndefined();
  });
});

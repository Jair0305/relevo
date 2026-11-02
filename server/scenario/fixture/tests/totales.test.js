import assert from 'node:assert/strict';
import { test } from 'node:test';

import { calcularTotal } from '../src/totales.js';

const conchas = (cantidad) => ({ nombre: 'Concha', precio: 25, cantidad });
const panDeMuerto = (cantidad) => ({ nombre: 'Pan de muerto', precio: 100, cantidad });

test('el cupón ESPIGA10 no descuenta el envío', () => {
  const r = calcularTotal({ productos: [panDeMuerto(2)], cupon: 'ESPIGA10' });
  assert.deepEqual(r, { subtotal: 200, envio: 79, descuento: 20, total: 259 });
});

test('un pedido de exactamente $500 tiene envío gratis', () => {
  const r = calcularTotal({ productos: [panDeMuerto(5)] });
  assert.equal(r.envio, 0);
  assert.equal(r.total, 500);
});

test('un pedido de $475 sigue pagando envío', () => {
  const r = calcularTotal({ productos: [panDeMuerto(4), conchas(3)] });
  assert.equal(r.envio, 79);
});

test('un cupón desconocido no descuenta nada', () => {
  const r = calcularTotal({ productos: [conchas(4)], cupon: 'NOEXISTE' });
  assert.equal(r.descuento, 0);
  assert.equal(r.total, 179);
});

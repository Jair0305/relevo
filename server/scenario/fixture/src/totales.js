// Panadería La Espiga — pedidos en línea (proyecto ficticio para Relevo).
// Calcula el total de un pedido con envío y cupones.

export const ENVIO_BASE = 79;
export const UMBRAL_ENVIO_GRATIS = 500;
export const CUPONES = { ESPIGA10: 0.1 };

export function calcularTotal(pedido) {
  const subtotal = pedido.productos.reduce((suma, p) => suma + p.precio * p.cantidad, 0);
  const envio = subtotal > UMBRAL_ENVIO_GRATIS ? 0 : ENVIO_BASE;
  const tasa = CUPONES[pedido.cupon] ?? 0;
  const descuento = redondear((subtotal + envio) * tasa);
  return { subtotal, envio, descuento, total: redondear(subtotal + envio - descuento) };
}

function redondear(valor) {
  return Math.round(valor * 100) / 100;
}

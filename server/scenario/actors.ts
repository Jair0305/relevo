/**
 * Actores de demostración. Son scripts deterministas, no modelos de IA: cada
 * uno sabe hacer exactamente un cambio y sigue una política fija. Lo que sí es
 * real es todo lo que pasa alrededor: Concord, git y las pruebas.
 */
import type { ActorId } from './types.ts';

export interface Fix {
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

export interface Actor {
  readonly id: ActorId;
  readonly name: string;
  readonly role: string;
  readonly taskId: string | null;
  readonly taskTitle: string | null;
  readonly fix: Fix | null;
}

export const CAJA: Actor = {
  id: 'caja',
  name: 'Caja',
  role: 'Arregla el cupón ESPIGA10',
  taskId: 'T-CUPON',
  taskTitle: 'El cupón ESPIGA10 no debe descontar el envío',
  fix: {
    label: 'Cupón sin descontar envío',
    before: 'const descuento = redondear((subtotal + envio) * tasa);',
    after: 'const descuento = redondear(subtotal * tasa); // el cupón no aplica al envío',
  },
};

export const REPARTO: Actor = {
  id: 'reparto',
  name: 'Reparto',
  role: 'Arregla el envío gratis desde $500',
  taskId: 'T-ENVIO',
  taskTitle: 'Envío gratis también en pedidos de exactamente $500',
  fix: {
    label: 'Envío gratis desde $500',
    before: 'const envio = subtotal > UMBRAL_ENVIO_GRATIS ? 0 : ENVIO_BASE;',
    after: 'const envio = subtotal >= UMBRAL_ENVIO_GRATIS ? 0 : ENVIO_BASE;',
  },
};

export const REVISION: Actor = {
  id: 'revision',
  name: 'Revisión',
  role: 'Vuelve a correr pruebas y cierra',
  taskId: null,
  taskTitle: null,
  fix: null,
};

export const ACTORS: readonly Actor[] = [CAJA, REPARTO, REVISION];

/**
 * El actor escribe el archivo completo a partir de la copia que leyó. Es lo
 * que hace una sesión que trabaja con contexto viejo, y es justo lo que provoca
 * la pérdida de cambios cuando nadie coordina.
 */
export function applyFix(snapshot: string, fix: Fix): string {
  if (!snapshot.includes(fix.before)) {
    throw new Error(`La copia leída no contiene la línea que "${fix.label}" esperaba cambiar.`);
  }
  return snapshot.replace(fix.before, fix.after);
}

export function hasFix(content: string, fix: Fix): boolean {
  return content.includes(fix.after);
}

export function requireFix(actor: Actor): Fix {
  if (actor.fix === null) throw new Error(`${actor.name} no tiene un arreglo asignado.`);
  return actor.fix;
}

export function requireTask(actor: Actor): { id: string; title: string } {
  if (actor.taskId === null || actor.taskTitle === null) {
    throw new Error(`${actor.name} no tiene tarea propia.`);
  }
  return { id: actor.taskId, title: actor.taskTitle };
}

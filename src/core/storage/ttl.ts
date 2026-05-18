/**
 * S0.5 — TTL de estado conversacional pendiente.
 *
 * Por qué existe: un `pending_input` o `pending_action` que nunca expira
 * secuestra el siguiente mensaje del usuario. Caso real: el bot pregunta
 * algo, el usuario se distrae una hora, vuelve y escribe algo no
 * relacionado — y el bot lo interpreta como respuesta a la pregunta vieja.
 *
 * Los valores son deliberadamente conservadores:
 *  - pending_input  (1 h): flujos multi-paso legítimos pueden tardar.
 *  - pending_action (5 min): una confirmación destructiva debe ser fresca;
 *    si pasaron 5 minutos, el usuario reconfirma — barato y seguro.
 *
 * Estos números son el contrato: memory.storage y postgres.storage deben
 * coincidir, y los tests verifican ambos contra estas constantes.
 */
export const PENDING_INPUT_TTL_MS = 60 * 60 * 1000; // 1 hora
export const PENDING_ACTION_TTL_MS = 5 * 60 * 1000; // 5 minutos

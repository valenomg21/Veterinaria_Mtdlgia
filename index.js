import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb'; // Adaptador obligatorio en Prisma 7
import dotenv from 'dotenv';
import crypto from 'crypto'; // Módulo para generar tokens de pago
import nodemailer from 'nodemailer'; // Módulo para envío de correos

// Cargar variables de entorno del archivo .env
dotenv.config();

const app = express();

// ==========================================
// MIDDLEWARES
// ==========================================
app.use(cors());          
app.use(express.json());  
app.use(express.static('public')); // Servirá tus archivos estáticos HTML/CSS/JS

// ==========================================
// CONFIGURACIÓN DEL ADAPTADOR DE MYSQL/MARIADB
// ==========================================
const adapter = new PrismaMariaDb({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'veterinaria_db',
    connectionLimit: 5
});

// Inicializamos PrismaClient
const prisma = new PrismaClient({ adapter });

// ==========================================
// CONFIGURACIÓN DEL TRANSPORTADOR DE CORREO (Mailtrap)
// ==========================================
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'sandbox.smtp.mailtrap.io',
    port: parseInt(process.env.SMTP_PORT || '2525'),
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

const PORT = process.env.PORT || 3001;

// ==========================================
// RUTA DE PRUEBA: Verificar conexión a MySQL
// ==========================================
app.get('/api/test', async (req, res) => {
    try {
        const veterinarios = await prisma.veterinario.findMany();
        res.json({
            mensaje: "Servidor conectado exitosamente a la base de datos usando Prisma 7",
            veterinarios_disponibles: veterinarios
        });
    } catch (error) {
        console.error("Error al conectar a la base de datos:", error);
        res.status(500).json({ 
            error: "No se pudo conectar a la base de datos", 
            detalle: error.message 
        });
    }
});

// ==========================================
// ENDPOINT PÚBLICO: Solicitar nuevo turno
// ==========================================
app.post('/api/turnos', async (req, res) => {
    try {
        const { 
            cliente_nombre, 
            cliente_telefono, 
            cliente_email, 
            mascota_nombre, 
            mascota_especie, 
            motivo_consulta, 
            fecha_preferida 
        } = req.body;

        // Validación básica
        if (!cliente_nombre || !cliente_telefono || !cliente_email || 
            !mascota_nombre || !mascota_especie || !motivo_consulta || !fecha_preferida) {
            return res.status(400).json({ error: "Todos los campos son obligatorios" });
        }

        const token_pago = crypto.randomBytes(32).toString('hex');
        const fechaFormateada = new Date(`${fecha_preferida}T00:00:00`);

        const nuevoTurno = await prisma.turno.create({
            data: {
                cliente_nombre,
                cliente_telefono,
                cliente_email,
                mascota_nombre,
                mascota_especie,
                motivo_consulta,
                fecha_preferida: fechaFormateada,
                token_pago,
                estado_turno: 'Pendiente',
                estado_pago: 'No Pago'
            }
        });

        res.status(201).json({
            mensaje: "Solicitud de turno registrada correctamente. Queda sujeta a confirmación por parte del administrador.",
            id_turno: nuevoTurno.id_turno
        });

    } catch (error) {
        console.error("Error al registrar solicitud de turno:", error);
        res.status(500).json({ 
            error: "Error interno del servidor al procesar la solicitud", 
            detalle: error.message 
        });
    }
});

// ==========================================
// ENDPOINT PÚBLICO (NUEVO/CORREGIDO): Obtener detalles de turno por token
// ==========================================
app.get('/api/turnos/token/:token', async (req, res) => {
    try {
        const { token } = req.params;

        const turno = await prisma.turno.findUnique({
            where: { token_pago: token },
            include: {
                veterinario: true // Incluye datos del veterinario si está asignado
            }
        });

        if (!turno) {
            return res.status(404).json({ error: "Turno no encontrado con el token proporcionado." });
        }

        res.json(turno);
    } catch (error) {
        console.error("Error al obtener turno por token:", error);
        res.status(500).json({ error: "Error interno del servidor al buscar el turno." });
    }
});

// ==========================================
// RUTA ADMINISTRATIVA: Listar todos los turnos (con filtro por estado opcional)
// ==========================================
app.get('/api/admin/turnos', async (req, res) => {
    try {
        const { estado } = req.query;
        const whereClause = estado ? { estado_turno: estado } : {};

        const turnos = await prisma.turno.findMany({
            where: whereClause,
            include: {
                veterinario: true
            },
            orderBy: {
                id_turno: 'desc'
            }
        });

        res.json(turnos);
    } catch (error) {
        console.error("Error al obtener los turnos:", error);
        res.status(500).json({ error: "Error al recuperar la información" });
    }
});

// ==========================================
// RUTA ADMINISTRATIVA: Aprobar turno y enviar enlace de pago
// ==========================================
app.put('/api/admin/turnos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { fecha_confirmada, hora_confirmada, id_veterinario } = req.body;

        if (!fecha_confirmada || !hora_confirmada || !id_veterinario) {
            return res.status(400).json({ error: "Falta asignar fecha, hora o veterinario" });
        }

        const fechaFormateada = new Date(`${fecha_confirmada}T00:00:00`);
        const horaFormateada = new Date(`1970-01-01T${hora_confirmada}:00`);

        const turnoActualizado = await prisma.turno.update({
            where: { id_turno: parseInt(id) },
            data: {
                fecha_confirmada: fechaFormateada,
                hora_confirmada: horaFormateada,
                id_veterinario: parseInt(id_veterinario),
                estado_turno: 'Esperando Pago'
            },
            include: {
                veterinario: true
            }
        });

        // Enlace ficticio de pago y generación del QR mediante API pública
        const enlacePago = `http://localhost:3001/pagar.html?token=${turnoActualizado.token_pago}`;
        const urlQR = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(enlacePago)}`;

        const cuerpoEmail = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #ddd; padding: 20px; border-radius: 8px;">
                <h2 style="color: #4A90E2; text-align: center;">¡Hola, ${turnoActualizado.cliente_nombre}!</h2>
                <p>Nos alegra informarte que el turno solicitado para tu mascota <strong>${turnoActualizado.mascota_nombre}</strong> (${turnoActualizado.mascota_especie}) ha sido pre-aprobado.</p>
                
                <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 5px solid #4A90E2;">
                    <h3 style="margin-top: 0; color: #333;">Detalles de la Cita Asignada:</h3>
                    <p><strong>Fecha:</strong> ${fecha_confirmada}</p>
                    <p><strong>Hora:</strong> ${hora_confirmada}</p>
                    <p><strong>Veterinario:</strong> ${turnoActualizado.veterinario.nombre} (${turnoActualizado.veterinario.especialidad})</p>
                </div>

                <p style="text-align: center; font-weight: bold; color: #ff5e5e;">Para confirmar definitivamente la reserva y evitar cancelaciones, es necesario realizar un pago de seña ficticio.</p>
                
                <div style="text-align: center; margin: 25px 0;">
                    <a href="${enlacePago}" style="background-color: #4A90E2; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">Pagar Reserva Online</a>
                </div>

                <div style="text-align: center; margin: 20px 0;">
                    <p style="font-size: 13px; color: #666; margin-bottom: 10px;">O escanea el siguiente código QR ficticio con tu celular:</p>
                    <img src="${urlQR}" style="border: 1px solid #ccc; padding: 5px; border-radius: 5px;" alt="Código QR de Pago" />
                </div>

                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
                <p style="font-size: 11px; color: #999; text-align: center;">Este es un mensaje simulado con fines académicos para la asignatura Metodología de la Investigación.</p>
            </div>
        `;

        await transporter.sendMail({
            from: '"Veterinaria López" <no-reply@veterinarialopez.com>',
            to: turnoActualizado.cliente_email,
            subject: `¡Turno Pre-Confirmado para ${turnoActualizado.mascota_nombre}!`,
            html: cuerpoEmail
        });

        res.json({
            mensaje: "Turno asignado exitosamente y correo de confirmación con enlace de pago enviado.",
            turno: turnoActualizado
        });

    } catch (error) {
        console.error("Error al asignar el turno:", error);
        res.status(500).json({ 
            error: "Error al actualizar y asignar el turno", 
            detalle: error.message 
        });
    }
});

// ==========================================
// ENDPOINT DE PAGO: Confirmar pago ficticio usando el Token
// ==========================================
app.post('/api/pagar', async (req, res) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ error: "El token de pago es requerido" });
        }

        const turnoExistente = await prisma.turno.findUnique({
            where: { token_pago: token }
        });

        if (!turnoExistente) {
            return res.status(404).json({ error: "El enlace de pago no es válido o ha expirado" });
        }

        if (turnoExistente.estado_pago === 'Pagado') {
            return res.status(400).json({ error: "Este turno ya ha sido pagado anteriormente" });
        }

        const turnoActualizado = await prisma.turno.update({
            where: { token_pago: token },
            data: {
                estado_turno: 'Confirmado',
                estado_pago: 'Pagado'
            }
        });

        res.json({
            mensaje: "Pago simulado con éxito. Su turno ha sido confirmado definitivamente.",
            turno: {
                cliente: turnoActualizado.cliente_nombre,
                mascota: turnoActualizado.mascota_nombre,
                fecha: turnoActualizado.fecha_confirmada,
                estado: turnoActualizado.estado_turno,
                pago: turnoActualizado.estado_pago
            }
        });

    } catch (error) {
        console.error("Error al procesar el pago:", error);
        res.status(500).json({ error: "Error interno al procesar el pago ficticio" });
    }
});

// ==========================================
// RUTA ADMINISTRATIVA: Obtener todos los veterinarios
// ==========================================
app.get('/api/veterinarios', async (req, res) => {
    try {
        const veterinarios = await prisma.veterinario.findMany();
        res.json(veterinarios);
    } catch (error) {
        console.error("Error al obtener veterinarios:", error);
        res.status(500).json({ error: "Error al recuperar la lista de veterinarios" });
    }
});

// Levantar el servidor
app.listen(PORT, () => {
    console.log(`Servidor de Veterinaria corriendo en http://localhost:${PORT}`);
});
import { prisma } from './config/db';
import { hashPassword } from './utils/password.util';

async function main() {
  const hashedPassword = await hashPassword('admin123');

  const usuario = await prisma.usuarios.upsert({
    where: { Credencial: 'admin' },
    update: {
      Password: hashedPassword,
      Activo: true,
      Rol: 'ADMIN'
    },
    create: {
      Credencial: 'admin',
      Nombre: 'Administrador del Sistema',
      Password: hashedPassword,
      Rol: 'ADMIN',
      Activo: true
    }
  });

  // SUPERVISOR por defecto con PIN de operación (autorización de reversiones).
  // El PIN se persiste SOLO como hash bcrypt: nunca en texto plano.
  const hashedSupervisorPassword = await hashPassword('supervisor');
  const hashedPinOperaciones = await hashPassword('1234');
  const supervisor = await prisma.usuarios.upsert({
    where: { Credencial: 'supervisor' },
    update: {
      Password: hashedSupervisorPassword,
      Activo: true,
      Rol: 'SUPERVISOR',
      PIN_Operaciones: hashedPinOperaciones
    },
    create: {
      Credencial: 'supervisor',
      Nombre: 'Supervisor de Caja',
      Password: hashedSupervisorPassword,
      Rol: 'SUPERVISOR',
      PIN_Operaciones: hashedPinOperaciones,
      Activo: true
    }
  });

  const clienteConsumidor = await prisma.clientes.upsert({
    where: { RIF_Cedula: 'V-00000000' },
    update: { Razon_Social: 'Consumidor Final' },
    create: {
      RIF_Cedula: 'V-00000000',
      Razon_Social: 'Consumidor Final',
      Direccion: 'Cliente de mostrador',
      Telefono: '0000000000',
      Email: 'consumidor@adrialga.local'
    }
  });
  console.log('✅ Cliente Consumidor Final listo:', clienteConsumidor.RIF_Cedula);

  // Datos legales de la tienda (encabezado de facturas/tickets PDF).
  // Idempotente: sin unique natural, se resuelve por findFirst+update/create.
  const configExistente = await prisma.configuracion_tienda.findFirst();
  if (!configExistente) {
    await prisma.configuracion_tienda.create({
      data: {
        Nombre: 'Ferretería Adrialga C.A.',
        RIF: 'J-30123456-8',
        Direccion: 'Av. Principal, Sector Centro, Local 5, Punto Fijo, Falcón',
        Telefono: '0268-123-4567'
      }
    });
    console.log('✅ Configuración de tienda creada (Ferretería Adrialga C.A.)');
  }

  console.log('✅ Usuario Admin listo:', usuario.Credencial);
  console.log(
    '✅ Usuario Supervisor listo:',
    supervisor.Credencial,
    '(PIN operación: 1234)'
  );
}

main()
  .catch((e) => console.error(e))
  .finally(async () => await prisma.$disconnect());
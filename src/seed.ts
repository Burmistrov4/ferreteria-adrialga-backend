import { prisma } from './config/db';
import { hashPassword } from './utils/password.util';

async function main() {
  const hashedPassword = await hashPassword('admin123');

  const usuario = await prisma.usuarios.upsert({
    where: { Credencial: 'admin' },
    update: {
      Password: hashedPassword,
      Activo: true
    },
    create: {
      Credencial: 'admin',
      Nombre: 'Administrador del Sistema',
      Password: hashedPassword,
      Rol: 'ADMIN',
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

  console.log('✅ Usuario Admin listo:', usuario.Credencial);
}

main()
  .catch((e) => console.error(e))
  .finally(async () => await prisma.$disconnect());
import { Module, forwardRef } from '@nestjs/common';
import { PasswordService } from './password.service';
import { UsersModule } from 'src/users/users.module';
import { ChatsModule } from 'src/chats/chats.module';

@Module({
  imports: [forwardRef(() => UsersModule), forwardRef(() => ChatsModule)],
  providers: [PasswordService],
  exports: [PasswordService],
})
export class PasswordModule {}

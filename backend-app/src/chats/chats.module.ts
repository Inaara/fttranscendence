import { Module, forwardRef } from '@nestjs/common';
import { ChatsController } from './chats.controller';
import { ChatsService } from './chats.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatEntity } from 'src/chats/entities/chat.entity';
import { ChatMessagesModule } from 'src/chat-messages/chat-messages.module';
import { UsersModule } from 'src/users/users.module';
import { ChatParticipantsModule } from 'src/chat-participants/chat-participants.module';
import { PasswordModule } from 'src/password/password.module';
import { InvitesModule } from 'src/invites/invites.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChatEntity]),
    forwardRef(() => ChatMessagesModule),
    forwardRef(() => UsersModule),
    forwardRef(() => ChatParticipantsModule),
    forwardRef(() => InvitesModule),
    forwardRef(() => PasswordModule),
  ],
  controllers: [ChatsController],
  providers: [ChatsService],
  exports: [ChatsService],
})
export class ChatsModule {}

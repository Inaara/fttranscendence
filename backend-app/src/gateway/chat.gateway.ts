import {
  OnModuleInit,
  Inject,
  forwardRef,
  ValidationPipe,
  UsePipes,
} from '@nestjs/common';
import { sendInviteDto } from 'src/invites/dtos/sendInvite.dto';
import { createChatMessageParams } from 'src/chat-messages/utils/types';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { AuthService } from 'src/auth/auth.service';
import { ChatMessagesService } from 'src/chat-messages/chat-messages.service';
import { ChatParticipantsService } from 'src/chat-participants/chat-participants.service';
import { ChatParticipantEntity } from 'src/chat-participants/entities/chat-participant.entity';
import { ChatsService } from 'src/chats/chats.service';
import {
  ChatJoinError,
  ChatPermissionError,
  InviteCreationError,
} from 'src/exceptions/bad-request.interceptor';
import { InviteEntity, inviteType } from 'src/invites/entities/Invite.entity';
import { InvitesService } from 'src/invites/invites.service';
import { UsersService } from 'src/users/users.service';
import { UserChatInfo } from 'src/chat-participants/utils/types';
import { ReceivedInfoDto } from './dtos/chatGateway.dto';
import { ChatEntity } from 'src/chats/entities/chat.entity';
import { Socket } from 'socket.io';
import { PasswordService } from 'src/password/password.service';

type UserTargetChat = {
  userID: number;
  targetID: number;
  chatRoomID: number;
};

enum RoomType {
  User,
  Chat,
}

// TODO [mcombeau]: Make WSExceptionFilter to translate HTTP exceptions
//                  to Websocket exceptions
@WebSocketGateway({
  cors: {
    origin: ['http://localhost:3000', 'http://localhost'],
  },
})
export class ChatGateway implements OnModuleInit {
  constructor(
    @Inject(forwardRef(() => ChatMessagesService))
    private chatMessagesService: ChatMessagesService,
    @Inject(forwardRef(() => ChatsService))
    private chatsService: ChatsService,
    @Inject(forwardRef(() => ChatParticipantsService))
    private chatParticipantsService: ChatParticipantsService,
    @Inject(forwardRef(() => UsersService))
    private userService: UsersService,
    @Inject(forwardRef(() => InvitesService))
    private inviteService: InvitesService,
    @Inject(forwardRef(() => AuthService))
    private authService: AuthService,
    @Inject(forwardRef(() => PasswordService))
    private passwordService: PasswordService,
  ) {}
  @WebSocketServer()
  server: Server;

  onModuleInit(): void {
    this.server.use(async (socket, next) => {
      const authorization_data = socket.handshake.headers.authorization;
      if (!authorization_data) return next(new Error('authentication error'));
      const token = authorization_data.split(' ')[1];

      const isVerified = await this.authService
        .validateToken(token)
        .catch(() => {
          return false;
        })
        .finally(() => {
          return true;
        });

      if (isVerified) {
        return next();
      }
      return next(new Error('authentication error'));
    });

    this.server.on('connection', async (socket) => {
      const token = socket.handshake.headers.authorization.split(' ')[1];
      const user = await this.authService
        .validateToken(token)
        .catch(() => {
          return false;
        })
        .finally(() => {
          return true;
        });

      console.log(
        `[Chat Gateway]: A user connected: ${user.username} - ${user.userID} (${socket.id})`,
      );
      socket.broadcast.emit('connection event'); // TODO: probably remove
      socket.on('disconnect', () => {
        console.log(
          `[Chat Gateway]: A user disconnected: ${user.username} - ${user.userID} (${socket.id})`,
        );
        socket.broadcast.emit('disconnection event');
      });
      await this.joinSocketRooms(socket, user.userID);
    });
  }

  // -------------------- EVENTS
  async checkIdentity(token: string): Promise<number> {
    const isVerified = await this.authService
      .validateToken(token)
      .catch(() => {
        return false;
      })
      .finally(() => {
        return true;
      });
    if (!token || !isVerified) {
      throw new ChatPermissionError('User not authenticated');
    }
    return isVerified.userID;
  }

  private async joinSocketRooms(socket: Socket, userID: number) {
    // Join channel named by the id of the user
    socket.data.userID = userID;
    await socket.join(this.getSocketRoomIdentifier(userID, RoomType.User));
    // Join all the channels the user is part of
    const chats = await this.userService.fetchUserChatsByUserID(userID);
    chats.map(async (chatRoom: ChatEntity) => {
      await socket.join(
        this.getSocketRoomIdentifier(chatRoom.id, RoomType.Chat),
      ); // Name of the socket room is the string id of the channel
    });
  }

  @SubscribeMessage('login')
  async onLogin(
    @ConnectedSocket() socket: Socket,
    @MessageBody() token: string,
  ): Promise<void> {
    console.log('[Chat Gateway]: Login', token);
    try {
      const userID = await this.checkIdentity(token);
      socket.data.userID = userID;

      socket.rooms.forEach(async (room: string) => {
        if (room !== socket.id) await socket.leave(room);
      });
      await this.joinSocketRooms(socket, userID);
      const username = (await this.userService.fetchUserByID(userID)).username;
      this.server
        .to(this.getSocketRoomIdentifier(userID, RoomType.User))
        .emit('login', username);
    } catch (e) {
      const err_msg = '[Chat Gateway]: login error:' + e.message;
      console.log(err_msg);
      // this.server
      //   .to(this.getSocketRoomIdentifier(userID, RoomType.User))
      //   .emit('error', err_msg);
    }
  }

  @SubscribeMessage('add chat')
  async onAddChat(
    @ConnectedSocket() socket: Socket,
    @MessageBody() info: ReceivedInfoDto,
  ): Promise<void> {
    console.log('[Chat Gateway]: Add chat', info);
    try {
      info.userID = await this.checkIdentity(info.token);
      info.chatInfo.ownerID = info.userID;
      const owner = await this.userService.fetchUserByID(info.userID);
      info.username = owner.username;
      const chat = await this.chatsService.createChat(info.chatInfo);
      info.chatRoomID = chat.id;
      info.chatInfo.hasPassword =
        await this.chatsService.fetchChatHasPasswordByID(info.chatRoomID);

      if (socket.data.userID === info.userID) {
        // Making the owner join the socket room
        await socket.join(
          this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat),
        );
      }
      info.token = '';
      this.server.emit('add chat', info);
    } catch (e) {
      const err_msg = '[Chat Gateway]: Chat creation error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('leave socket room')
  async onLeaveSocketRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody() info: ReceivedInfoDto,
  ): Promise<void> {
    console.log('[Chat Gateway]: Leave socket room:', info);
    try {
      info.userID = await this.checkIdentity(info.token);
      const userParticipant =
        await this.chatParticipantsService.fetchParticipantEntityByUserChatID({
          userID: info.userID,
          chatRoomID: info.chatRoomID,
        });
      if (!userParticipant || userParticipant.isBanned) {
        await socket.leave(
          this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat),
        );
      }
    } catch (e) {
      const err_msg = '[Chat Gateway]: Leave socket room error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('join socket room')
  async onJoinSocketRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody() info: ReceivedInfoDto,
  ): Promise<void> {
    console.log('[Chat Gateway]: Join socket room:', info);
    try {
      info.userID = await this.checkIdentity(info.token);
      const userParticipant =
        await this.chatParticipantsService.fetchParticipantEntityByUserChatID({
          userID: info.userID,
          chatRoomID: info.chatRoomID,
        });
      if (userParticipant) {
        await socket.join(
          this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat),
        );
      }
    } catch (e) {
      const err_msg = '[Chat Gateway]: join socket room error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('dm')
  async onDM(
    @ConnectedSocket() socket: Socket,
    @MessageBody() info: ReceivedInfoDto,
  ): Promise<void> {
    try {
      info.userID = await this.checkIdentity(info.token);

      const chat = await this.chatsService.createChatDM({
        userID1: info.userID,
        userID2: info.targetID,
      });
      const user1 = await this.userService.fetchUserByID(info.userID);
      const user2 = await this.userService.fetchUserByID(info.targetID);
      info.chatRoomID = chat.id;
      info.username = user1.username;
      info.username2 = user2.username;
      info.token = '';
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .to(this.getSocketRoomIdentifier(info.targetID, RoomType.User))
        .emit('dm', info);
    } catch (e) {
      const err_msg = '[Chat Gateway]: DM creation error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('delete chat')
  async onDeleteChat(@MessageBody() info: ReceivedInfoDto): Promise<void> {
    console.log('[Chat Gateway]: Delete chat', info);
    try {
      info.userID = await this.checkIdentity(info.token);
      this.deleteChatRoom({ userID: info.userID, chatRoomID: info.chatRoomID });
      info.token = '';
      this.server.emit('delete chat', info);
    } catch (e) {
      const err_msg = '[Chat Gateway]: Chat deletion error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  // TODO: Validate chat join by checking password if there is one.
  @SubscribeMessage('join chat')
  async onJoinChat(
    @ConnectedSocket() socket: Socket,
    @MessageBody() info: ReceivedInfoDto,
  ): Promise<void> {
    // TODO: good error message "You have been banned"
    try {
      console.log('[Chat Gateway]: Join chat', info);
      info.userID = await this.checkIdentity(info.token);
      const user = await this.userService.fetchUserByID(info.userID);
      await this.checkChatRoomPassword(info.chatInfo.password, info.chatRoomID);
      await this.addUserToChat({
        userID: info.userID,
        chatRoomID: info.chatRoomID,
      });
      const chat = await this.chatsService.fetchChatByID(info.chatRoomID);
      info.username = user.username;
      info = {
        ...info,
        chatInfo: {
          isPrivate: chat.isPrivate,
          isDirectMessage: chat.isDirectMessage,
          name: chat.name,
        },
      };

      if (socket.data.userID === info.userID) {
        // Making the participants join the socket room
        await socket.join(
          this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat),
        );
      }
      info.token = '';
      this.server
        .to(this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat))
        .emit('join chat', info);
    } catch (e) {
      const err_msg = '[Chat Gateway]: Chat join error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('leave chat')
  async onLeaveChat(
    @ConnectedSocket() socket: Socket,
    @MessageBody() info: ReceivedInfoDto,
  ): Promise<void> {
    try {
      info.userID = await this.checkIdentity(info.token);
      info.username = (
        await this.userService.fetchUserByID(info.userID)
      ).username;
      await this.leaveChatRoom({
        userID: info.userID,
        chatRoomID: info.chatRoomID,
      });

      info.token = '';
      this.server
        .to(this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat))
        .emit('leave chat', info);
      if (socket.data.userID === info.userID) {
        // Making the participant leave the socket room
        await socket.leave(
          this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat),
        );
      }
    } catch (e) {
      const err_msg = '[Chat Gateway]: Chat leave error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('chat message')
  async onChatMessage(@MessageBody() info: ReceivedInfoDto): Promise<void> {
    console.log('[Chat Gateway]: Sending chat message');
    try {
      const userID = await this.checkIdentity(info.token);
      info.userID = userID;
      info.messageInfo.senderID = userID;
      info.messageInfo.chatRoomID = info.chatRoomID;
      const user = await this.userService.fetchUserByID(info.userID);
      info.username = user.username;
      await this.registerChatMessage(info.messageInfo);

      info.token = '';
      this.server
        .to(this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat))
        .emit('chat message', info);
    } catch (e) {
      const err_msg =
        '[Chat Gateway]: Chat message registration error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('mute')
  async onMute(
    @ConnectedSocket() socket: Socket,
    @MessageBody() info: ReceivedInfoDto,
  ): Promise<void> {
    try {
      info.userID = await this.checkIdentity(info.token);
      info.username = (
        await this.userService.fetchUserByID(info.targetID)
      ).username;
      info.participantInfo.mutedUntil = await this.toggleMute(
        info.chatRoomID,
        info.userID,
        info.targetID,
        info.participantInfo.mutedUntil,
      );
      info.token = '';
      console.log('Muted date:', info.participantInfo.mutedUntil);
      console.log('Muted date:', info.participantInfo.mutedUntil.toString());
      console.log(
        'Muted date:',
        new Date(info.participantInfo.mutedUntil).toString(),
      );
      this.server
        .to(this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat))
        .emit('mute', info);
    } catch (e) {
      const err_msg = '[Chat Gateway]: User mute error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('toggle private')
  async onTogglePrivate(@MessageBody() info: ReceivedInfoDto): Promise<void> {
    console.log('[Chat Gateway]: Toggle private chat');
    try {
      info.userID = await this.checkIdentity(info.token);
      info.username = (
        await this.userService.fetchUserByID(info.userID)
      ).username;
      const chat = await this.getChatRoomOrFail(info.chatRoomID);
      info = {
        ...info,
        chatInfo: {
          isPrivate: await this.toggleChatPrivacy({
            userID: info.userID,
            chatRoomID: info.chatRoomID,
          }),
          name: chat.name,
          isDirectMessage: chat.isDirectMessage, // Useful ?
          hasPassword: await this.chatsService.fetchChatHasPasswordByID(
            info.chatRoomID,
          ),
        },
      };

      info.token = '';
      this.server.emit('toggle private', info);
    } catch (e) {
      const err_msg = '[Chat Gateway]: Chat privacy toggle error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('invite')
  async onInvite(@MessageBody() info: ReceivedInfoDto): Promise<void> {
    try {
      info.userID = await this.checkIdentity(info.token);
      const invite = await this.inviteUser({
        userID: info.userID,
        targetID: info.targetID,
        chatRoomID: info.chatRoomID,
      });
      info.inviteInfo = invite;
      info.inviteInfo.chatHasPassword =
        await this.chatsService.fetchChatHasPasswordByID(info.chatRoomID);
      info.token = '';
      this.server
        .to(
          this.getSocketRoomIdentifier(
            info.inviteInfo.invitedID,
            RoomType.User,
          ),
        )
        .to(
          this.getSocketRoomIdentifier(info.inviteInfo.senderID, RoomType.User),
        )
        .emit('invite', info);
    } catch (e) {
      const err_msg = '[Chat Gateway]: Chat invite error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('accept invite')
  async onAcceptInvite(
    @ConnectedSocket() socket: Socket,
    @MessageBody() info: ReceivedInfoDto,
  ): Promise<void> {
    try {
      console.log('[Chat Gateway]: accept invite', info);
      info.userID = await this.checkIdentity(info.token);
      const user = await this.userService.fetchUserByID(info.userID);
      await this.checkChatRoomPassword(
        info.chatInfo.password,
        info.inviteInfo.chatRoomID,
      );
      await this.acceptUserInvite({
        userID: info.userID,
        chatRoomID: info.inviteInfo.chatRoomID,
      });
      info.username = user.username;
      info.token = '';
      const chat = await this.chatsService.fetchChatByID(
        info.inviteInfo.chatRoomID,
      );
      info.chatRoomID = chat.id;
      info.chatInfo = {
        name: chat.name,
        isPrivate: chat.isPrivate,
      };
      if (socket.data.userID === info.userID) {
        // Making the participants join the socket room
        await socket.join(
          this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat),
        );
      }
      this.server
        .to(this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat))
        .emit('accept invite', info);
    } catch (e) {
      const err_msg = '[Chat Gateway]: Chat accept invite error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('refuse invite')
  async onRefuseInvite(
    @ConnectedSocket() socket: Socket,
    @MessageBody() info: ReceivedInfoDto,
  ): Promise<void> {
    try {
      console.log('[Chat Gateway]: Refuse invite', info);
      info.userID = await this.checkIdentity(info.token);
      await this.refuseUserInvite(info.inviteInfo);
      info.token = '';
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('refuse invite', info);
    } catch (e) {
      const err_msg = '[Chat Gateway]: Chat refuse invite error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('operator')
  async onMakeOperator(@MessageBody() info: ReceivedInfoDto): Promise<void> {
    try {
      info.userID = await this.checkIdentity(info.token);
      const user = await this.userService.fetchUserByID(info.targetID);
      info.username = user.username;
      await this.toggleOperator({
        userID: info.userID,
        targetID: info.targetID,
        chatRoomID: info.chatRoomID,
      });
      const participant = await this.getParticipantOrFail({
        userID: info.targetID,
        chatRoomID: info.chatRoomID,
      });
      info = {
        ...info,
        participantInfo: {
          isOperator: participant.isOperator,
        },
      };
      info.token = '';
      this.server
        .to(this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat))
        .emit('operator', info);
    } catch (e) {
      const err_msg = '[Chat Gateway]: Operator promotion error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('ban')
  async onBan(
    @ConnectedSocket() socket: Socket,
    @MessageBody() info: ReceivedInfoDto,
  ): Promise<void> {
    try {
      info.userID = await this.checkIdentity(info.token);
      info.username = (
        await this.userService.fetchUserByID(info.targetID)
      ).username;
      const isBanned = await this.banUser({
        userID: info.userID,
        targetID: info.targetID,
        chatRoomID: info.chatRoomID,
      });
      info = {
        ...info,
        participantInfo: {
          isBanned: isBanned,
        },
      };
      info.token = '';
      this.server
        .to(this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat))
        .emit('ban', info);
      if (info.targetID === socket.data.userID) {
        await socket.leave(
          this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat),
        );
      }
    } catch (e) {
      const err_msg = '[Chat Gateway]: User ban error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('kick')
  async onKick(@MessageBody() info: ReceivedInfoDto): Promise<void> {
    try {
      info.userID = await this.checkIdentity(info.token);
      info.username = (
        await this.userService.fetchUserByID(info.targetID)
      ).username;

      await this.kickUser({
        userID: info.userID,
        targetID: info.targetID,
        chatRoomID: info.chatRoomID,
      });

      info.token = '';
      this.server
        .to(this.getSocketRoomIdentifier(info.chatRoomID, RoomType.Chat))
        .emit('kick', info);
    } catch (e) {
      const err_msg = '[Chat Gateway]: User kick error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  @SubscribeMessage('set password')
  async onSetPassword(@MessageBody() info: ReceivedInfoDto): Promise<void> {
    try {
      console.log('[Chat Gateway]: set password:', info);
      info.userID = await this.checkIdentity(info.token);

      await this.setPassword(
        {
          userID: info.userID,
          chatRoomID: info.chatRoomID,
        },
        info.chatInfo.password,
      );

      info.chatInfo.hasPassword =
        await this.chatsService.fetchChatHasPasswordByID(info.chatRoomID);

      console.log('[Chat Gateway]: After setting password', info);
      info.token = '';
      info.chatInfo.password = '';
      this.server.emit('set password', info);
    } catch (e) {
      const err_msg = '[Chat Gateway]: User set password error:' + e.message;
      console.log(err_msg);
      this.server
        .to(this.getSocketRoomIdentifier(info.userID, RoomType.User))
        .emit('error', err_msg);
    }
  }

  // --------------------  PERMISSION CHECKS

  private async getChatRoomOrFail(chatRoomID: number): Promise<ChatEntity> {
    const chatRoom = await this.chatsService.fetchChatByID(chatRoomID);
    if (!chatRoom) {
      throw new ChatPermissionError(`Chat '${chatRoomID} does not exist.`);
    }
    return chatRoom;
  }

  private async getParticipantOrFail(
    info: UserChatInfo,
  ): Promise<ChatParticipantEntity> {
    await this.getChatRoomOrFail(info.chatRoomID);
    const userParticipant =
      await this.chatParticipantsService.fetchParticipantEntityByUserChatID(
        info,
      );
    if (!userParticipant) {
      throw new ChatPermissionError(
        `User '${info.userID} is not in or invited to chat '${info.chatRoomID}`,
      );
    }
    return userParticipant;
  }

  private async checkUserIsOwner(user: ChatParticipantEntity): Promise<void> {
    if (!user) {
      throw new ChatPermissionError(
        `Unexpected error during owner permission check: participant does not exist.`,
      );
    }
    if (!user.isOwner) {
      throw new ChatPermissionError(
        `User '${user.user.username}' is not owner of chat '${user.chatRoom.name}'.`,
      );
    }
  }

  private async checkUserIsNotOwner(
    user: ChatParticipantEntity,
  ): Promise<void> {
    if (!user) {
      throw new ChatPermissionError(
        `Unexpected error during owner permission check: participant does not exist.`,
      );
    }
    if (user.isOwner) {
      throw new ChatPermissionError(
        `User '${user.user.username}' is owner of chat '${user.chatRoom.name}'.`,
      );
    }
  }

  private async checkUserHasOperatorPermissions(
    user: ChatParticipantEntity,
  ): Promise<void> {
    if (!user) {
      throw new ChatPermissionError(
        `Unexpected error during operator permission check: participant does not exist.`,
      );
    }
    if (!user.isOperator && !user.isOwner) {
      throw new ChatPermissionError(
        `User '${user.user.username}' does not have operator privileges in chat '${user.chatRoom.name}'.`,
      );
    }
  }

  private async checkUserIsNotOperator(
    user: ChatParticipantEntity,
  ): Promise<void> {
    if (!user) {
      throw new ChatPermissionError(
        `Unexpected error during operator permission check: participant does not exist.`,
      );
    }
    if (user.isOperator || user.isOwner) {
      throw new ChatPermissionError(
        `User '${user.user.username}' is operator of chat '${user.chatRoom.name}'.`,
      );
    }
  }

  private async checkUserIsNotBanned(
    user: ChatParticipantEntity,
  ): Promise<void> {
    if (!user) {
      throw new ChatPermissionError(
        `Unexpected error during operator permission check: participant does not exist.`,
      );
    }
    if (user.isBanned) {
      throw new ChatPermissionError(
        `User '${user.user.username}' is banned from chat '${user.chatRoom.name}'.`,
      );
    }
  }

  private async checkUserIsNotMuted(
    user: ChatParticipantEntity,
  ): Promise<void> {
    if (!user) {
      throw new ChatPermissionError(
        `Unexpected error during muted check: participant does not exist.`,
      );
    }
    if (user.mutedUntil > new Date().getTime()) {
      throw new ChatPermissionError(
        `User '${user.user.username}' is muted in chat '${user.chatRoom.name}'.`,
      );
    }
  }

  private async checkUserInviteIsNotPending(
    invite: InviteEntity,
  ): Promise<void> {
    if (!invite) {
      throw new ChatPermissionError(
        `Unexpected error during invite check: invite does not exist.`,
      );
    }
    if (invite.expiresAt > new Date().getTime()) {
      throw new ChatPermissionError(
        `User '${invite.invitedUser.username}' invite to chat '${invite.chatRoom.name}' is pending.`,
      );
    }
  }

  private async checkUserInviteHasNotExpired(
    info: UserChatInfo,
  ): Promise<void> {
    const invite = await this.inviteService.fetchInviteByInvitedUserChatRoomID(
      info,
    );
    if (!invite) {
      throw new ChatPermissionError(
        `User '${info.userID}' has not been invited to chat '${info.chatRoomID}'.`,
      );
    }
    if (invite.expiresAt < new Date().getTime()) {
      await this.inviteService.deleteInviteByID(invite.id);
      throw new ChatPermissionError(
        `User '${info.userID}' invite to chat '${info.chatRoomID}' has expired.`,
      );
    }
  }

  private async checkUserHasNotAlreadyAcceptedInvite(
    user: ChatParticipantEntity,
  ): Promise<void> {
    if (user) {
      throw new ChatPermissionError(
        `User '${user.user.username}' has already accepted invite to chat '${user.chatRoom.name}'.`,
      );
    }
  }

  private async checkChatRoomPassword(
    password: string,
    chatRoomID: number,
  ): Promise<void> {
    console.log('Check Chat Room Pass', password, chatRoomID);
    const chat = await this.getChatRoomOrFail(chatRoomID);
    const passwordOK = await this.passwordService.checkPasswordChat(
      password,
      chat,
    );
    console.log('[Chat Gateway]: password is OK ?', passwordOK);
    console.log('[Chat Gateway]: inputted password', password);
    if (!passwordOK) {
      throw new ChatPermissionError(
        `Invalid password for chatroom ${chat.name}`,
      );
    }
  }

  // -------------------- HANDLERS

  private async addUserToChat(info: UserChatInfo): Promise<void> {
    const chatRoom = await this.getChatRoomOrFail(info.chatRoomID);
    if (chatRoom.isPrivate === true) {
      throw new ChatJoinError(`Chat '${info.chatRoomID}' is private.`);
    }
    const participant =
      await this.chatParticipantsService.fetchParticipantEntityByUserChatID(
        info,
      );
    if (participant) {
      if (participant.isBanned) {
        throw new ChatJoinError(
          `User '${info.userID}' is banned from '${info.chatRoomID}'.`,
        );
      }
      console.log('[Chat Gateway]: participant', participant);
      throw new ChatJoinError(
        `User '${info.userID}' is already in chat '${info.chatRoomID}'.`,
      );
    }
    if (participant && participant.isBanned) {
      throw new ChatJoinError(
        `User '${info.userID}' is banned from chat '${info.chatRoomID}'.`,
      );
    }
    await this.chatsService.addParticipantToChatByUserChatID(info);
  }

  private async registerChatMessage(
    chatMessageDetails: createChatMessageParams,
  ): Promise<void> {
    const user = await this.getParticipantOrFail({
      userID: chatMessageDetails.senderID,
      chatRoomID: chatMessageDetails.chatRoomID,
    });

    await this.checkUserIsNotMuted(user);
    await this.checkUserIsNotBanned(user);

    await this.chatMessagesService.createMessage(chatMessageDetails);
  }

  private async toggleMute(
    chatRoomID: number,
    userID: number,
    targetUserID: number,
    minutes: number,
  ): Promise<number> {
    const user = await this.getParticipantOrFail({
      userID: userID,
      chatRoomID: chatRoomID,
    });
    const target = await this.getParticipantOrFail({
      userID: targetUserID,
      chatRoomID: chatRoomID,
    });

    await this.checkUserHasOperatorPermissions(user);
    await this.checkUserIsNotOperator(target);
    await this.checkUserIsNotBanned(target);

    let newMutedTimestamp = 0;
    if (user.mutedUntil > new Date().getTime()) {
      newMutedTimestamp = new Date().getTime();
    } else {
      newMutedTimestamp = new Date(
        Date.now() + minutes * (60 * 1000),
      ).getTime();
      console.log('Muted date:', newMutedTimestamp);
      console.log('Muted date:', newMutedTimestamp.toString());
      console.log('Muted date:', new Date(newMutedTimestamp).toString());
    }
    await this.chatParticipantsService.updateParticipantByID(target.id, {
      mutedUntil: newMutedTimestamp,
    });
    return newMutedTimestamp;
  }

  private async toggleOperator(info: UserTargetChat): Promise<void> {
    const user = await this.getParticipantOrFail({
      chatRoomID: info.chatRoomID,
      userID: info.userID,
    });
    const target = await this.getParticipantOrFail({
      chatRoomID: info.chatRoomID,
      userID: info.targetID,
    });

    await this.checkUserIsOwner(user);
    await this.checkUserIsNotOwner(target);
    await this.checkUserIsNotBanned(target);

    await this.chatParticipantsService.updateParticipantByID(target.id, {
      isOperator: !target.isOperator,
    });
  }

  private async banUser(info: UserTargetChat): Promise<boolean> {
    const user = await this.getParticipantOrFail({
      chatRoomID: info.chatRoomID,
      userID: info.userID,
    });
    const target = await this.getParticipantOrFail({
      chatRoomID: info.chatRoomID,
      userID: info.targetID,
    });

    await this.checkUserHasOperatorPermissions(user);
    await this.checkUserIsNotOwner(target);

    if (target.isBanned) {
      // Unban
      await this.chatParticipantsService.deleteParticipantByID(target.id);
      return false;
    } else {
      // Ban
      await this.chatParticipantsService.updateParticipantByID(target.id, {
        isBanned: true,
      });
      return true;
    }
  }

  private async kickUser(info: UserTargetChat): Promise<void> {
    const user = await this.getParticipantOrFail({
      chatRoomID: info.chatRoomID,
      userID: info.userID,
    });
    const target = await this.getParticipantOrFail({
      chatRoomID: info.chatRoomID,
      userID: info.targetID,
    });

    await this.checkUserHasOperatorPermissions(user);
    await this.checkUserIsNotOwner(target);
    await this.checkUserIsNotBanned(target);

    await this.chatParticipantsService.deleteParticipantByID(target.id);
  }

  private async toggleChatPrivacy(info: UserChatInfo): Promise<boolean> {
    const user = await this.getParticipantOrFail(info);
    const chatRoom = await this.getChatRoomOrFail(info.chatRoomID);

    await this.checkUserIsOwner(user);

    await this.chatsService.updateChatByID(chatRoom.id, {
      isPrivate: !chatRoom.isPrivate,
    });
    const updatedChatRoom = await this.getChatRoomOrFail(info.chatRoomID);
    const isPrivate = updatedChatRoom.isPrivate;
    return isPrivate;
  }

  private async inviteUser(info: UserTargetChat): Promise<sendInviteDto> {
    await this.getParticipantOrFail({
      userID: info.userID,
      chatRoomID: info.chatRoomID,
    });

    const target =
      await this.chatParticipantsService.fetchParticipantEntityByUserChatID({
        userID: info.targetID,
        chatRoomID: info.chatRoomID,
      });
    if (target) {
      throw new InviteCreationError(
        `${target.user.id} cannot be invited: already in chat room ${info.chatRoomID}`,
      );
    }
    const invite = await this.inviteService.createInvite({
      type: inviteType.CHAT,
      senderID: info.userID,
      invitedUserID: info.targetID,
      chatRoomID: info.chatRoomID,
    });
    return invite;
  }

  private async acceptUserInvite(info: UserChatInfo): Promise<void> {
    try {
      const invite =
        await this.inviteService.fetchInviteByInvitedUserChatRoomID(info);
      await this.checkUserInviteHasNotExpired(info);

      // TODO: can a banned user be invited to chatroom?
      const user =
        await this.chatParticipantsService.fetchParticipantEntityByUserChatID(
          info,
        );
      if (user) {
        await this.checkUserHasNotAlreadyAcceptedInvite(user);
        await this.checkUserIsNotBanned(user);
      }

      await this.chatParticipantsService.createChatParticipant({
        userID: invite.invitedUser.id,
        chatRoomID: invite.chatRoom.id,
      });
      await this.inviteService.deleteInvitesByInvitedUserChatRoomID(info);
    } catch (e) {
      throw new ChatPermissionError(e.message);
    }
  }

  private async refuseUserInvite(invite: sendInviteDto): Promise<void> {
    try {
      await this.inviteService.deleteInviteByID(invite.id);
    } catch (e) {
      throw new ChatPermissionError(e.message);
    }
  }

  private async deleteChatRoom(info: UserChatInfo): Promise<void> {
    const chat = await this.getChatRoomOrFail(info.chatRoomID);
    const user = await this.getParticipantOrFail(info);

    await this.checkUserIsOwner(user);
    await this.chatsService.deleteChatByID(chat.id);
  }

  private async leaveChatRoom(info: UserChatInfo): Promise<void> {
    await this.chatsService.removeParticipantFromChatByUsername({
      userID: info.userID,
      chatRoomID: info.chatRoomID,
    });
  }

  private async setPassword(
    info: UserChatInfo,
    password: string,
  ): Promise<void> {
    await this.getChatRoomOrFail(info.chatRoomID);
    const user = await this.getParticipantOrFail(info);

    await this.checkUserIsOwner(user);
    await this.chatsService.updateChatByID(info.chatRoomID, {
      password: password,
    });
  }

  private getSocketRoomIdentifier(id: number, type: RoomType): string {
    switch (type) {
      case RoomType.User:
        return 'user' + id.toString();
      default:
        return 'chat' + id.toString();
    }
  }
}

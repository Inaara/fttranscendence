import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ChatsService } from 'src/chats/chats.service';
import { UsersService } from 'src/users/users.service';
import { Repository, DeleteResult } from 'typeorm';
import { inviteParams } from './utils/types';
import { InviteEntity, inviteType } from './entities/Invite.entity';
import { InviteCreationError } from 'src/exceptions/bad-request.interceptor';
import { UserChatInfo } from 'src/chat-participants/utils/types';
import { sendInviteDto } from './dtos/sendInvite.dto';

@Injectable()
export class InvitesService {
  constructor(
    @InjectRepository(InviteEntity)
    private inviteRepository: Repository<InviteEntity>,
    @Inject(forwardRef(() => ChatsService))
    private chatService: ChatsService,
    @Inject(forwardRef(() => UsersService))
    private userService: UsersService,
  ) {}

  private async formatInviteForSending(
    invite: InviteEntity,
  ): Promise<sendInviteDto> {
    const sendInvite: sendInviteDto = {
      id: invite.id,
      type: invite.type,
      expiresAt: invite.expiresAt,
      senderID: invite.inviteSender.id,
      senderUsername: invite.inviteSender.username,
      invitedID: invite.invitedUser.id,
      invitedUsername: invite.invitedUser.username,
    };
    if (invite.type === inviteType.CHAT) {
      sendInvite.chatRoomID = invite.chatRoom.id;
      sendInvite.chatRoomName = invite.chatRoom.name;
      sendInvite.chatHasPassword =
        await this.chatService.fetchChatHasPasswordByID(invite.chatRoom.id);
    }
    return sendInvite;
  }

  private async formatInvitesArrayForSending(
    invites: InviteEntity[],
  ): Promise<sendInviteDto[]> {
    return await Promise.all(
      invites.map(async (e: InviteEntity) => {
        return await this.formatInviteForSending(e);
      }),
    );
  }

  async fetchAllInvites(): Promise<sendInviteDto[]> {
    await this.deleteExpiredInvites();
    const invites = await this.inviteRepository.find({
      relations: ['inviteSender', 'invitedUser', 'chatRoom'],
    });
    return this.formatInvitesArrayForSending(invites);
  }

  async fetchInviteByID(id: number): Promise<sendInviteDto> {
    await this.deleteExpiredInvites();
    const invite = await this.fetchInviteEntityByID(id);
    return this.formatInviteForSending(invite);
  }

  async fetchInviteEntityByID(id: number): Promise<InviteEntity> {
    await this.deleteExpiredInvites();
    return this.inviteRepository.findOne({
      where: { id: id },
      relations: ['inviteSender', 'invitedUser', 'chatRoom'],
    });
  }

  async fetchInvitesByInvitedID(userID: number): Promise<sendInviteDto[]> {
    await this.deleteExpiredInvites();
    const user = await this.userService.fetchUserByID(userID);
    const invites = await this.inviteRepository.find({
      where: { invitedUser: user },
      relations: ['inviteSender', 'invitedUser', 'chatRoom'],
    });
    return this.formatInvitesArrayForSending(invites);
  }

  async fetchInvitesBySenderID(userID: number): Promise<sendInviteDto[]> {
    await this.deleteExpiredInvites();
    const user = await this.userService.fetchUserByID(userID);
    const invites = await this.inviteRepository.find({
      where: { inviteSender: user },
      relations: ['inviteSender', 'invitedUser', 'chatRoom'],
    });
    return this.formatInvitesArrayForSending(invites);
  }

  async fetchInvitesByChatRoomID(chatRoomID: number): Promise<sendInviteDto[]> {
    await this.deleteExpiredInvites();
    const chatRoom = await this.chatService.fetchChatByID(chatRoomID);
    const invites = await this.inviteRepository.find({
      where: { chatRoom: chatRoom },
      relations: ['inviteSender', 'invitedUser', 'chatRoom'],
    });
    return this.formatInvitesArrayForSending(invites);
  }

  async fetchInviteByInvitedUserChatRoomID(
    info: UserChatInfo,
  ): Promise<InviteEntity> {
    await this.deleteExpiredInvites();
    const chatRoom = await this.chatService.fetchChatByID(info.chatRoomID);
    const user = await this.userService.fetchUserByID(info.userID);
    return await this.inviteRepository.findOne({
      where: { invitedUser: user, chatRoom: chatRoom },
      relations: ['inviteSender', 'invitedUser', 'chatRoom'],
    });
  }

  async fetchAllInvitesByInvitedUserChatRoomIDs(
    info: UserChatInfo,
  ): Promise<InviteEntity[]> {
    await this.deleteExpiredInvites();
    const chatRoom = await this.chatService.fetchChatByID(info.chatRoomID);
    const user = await this.userService.fetchUserByID(info.userID);
    const invites = this.inviteRepository.find({
      where: { invitedUser: user, chatRoom: chatRoom },
      relations: ['inviteSender', 'invitedUser', 'chatRoom'],
    });
    return invites;
    // return this.formatInvitesArrayForSending(invites);
  }

  async createInvite(inviteDetails: inviteParams): Promise<sendInviteDto> {
    switch (inviteDetails.type) {
      case inviteType.CHAT:
        const invite = await this.createChatInvite(inviteDetails);
        return this.formatInviteForSending(invite);
      // case inviteType.GAME:
      //   return this.createGameInvite(inviteDetails);
      // case inviteType.FRIEND:
      //   return this.createFriendInvite(inviteDetails);
      default:
        throw new InviteCreationError('invalid invite type.');
    }
  }

  private async createChatInvite(
    inviteDetails: inviteParams,
  ): Promise<InviteEntity> {
    const sender = await this.userService.fetchUserByID(inviteDetails.senderID);
    const invitedUser = await this.userService.fetchUserByID(
      inviteDetails.invitedUserID,
    );
    const chatRoom = await this.chatService.fetchChatByID(
      inviteDetails.chatRoomID,
    );

    if (!sender || !invitedUser || !chatRoom) {
      throw new InviteCreationError('invalid parameters for invite creation.');
    }

    let inviteExpiry = 0;
    inviteExpiry = new Date(
      Date.now() + 1 * (60 * 60 * 1000), // time + 1 hour
    ).getTime();

    const invite = await this.inviteRepository.findOne({
      where: {
        inviteSender: sender,
        invitedUser: invitedUser,
        chatRoom: chatRoom,
      },
    });
    if (invite) {
      // invite already exists, updating invite expiry.
      await this.inviteRepository.update(invite.id, {
        expiresAt: inviteExpiry,
      });
      return this.fetchInviteEntityByID(invite.id);
    } else {
      return this.inviteRepository.save({
        type: inviteType.CHAT,
        expiresAt: inviteExpiry,
        inviteSender: sender,
        invitedUser: invitedUser,
        chatRoom: chatRoom,
      });
    }
  }

  private async createGameInvite(inviteDetails: inviteParams) {
    // TODO [mcombeau]: implement this
    throw new InviteCreationError('game invites not implemented yet.');
  }

  private async createFriendInvite(inviteDetails: inviteParams) {
    // TODO [mcombeau]: implement this
    throw new InviteCreationError('friend invites not implemented yet.');
  }

  async deleteInvitesByInvitedUserChatRoomID(
    info: UserChatInfo,
  ): Promise<DeleteResult> {
    const invites = await this.fetchAllInvitesByInvitedUserChatRoomIDs(info);
    invites.map(async (e) => {
      await this.deleteInviteByID(e.id);
    });
    return;
  }

  async deleteInviteByID(id: number): Promise<DeleteResult> {
    return this.inviteRepository.delete({ id });
  }

  async deleteExpiredInvites() {
    const invites = await this.inviteRepository.find({
      relations: ['inviteSender', 'invitedUser', 'chatRoom'],
    });
    invites.map(async (e) => {
      if (e.expiresAt < new Date().getTime()) {
        await this.deleteInviteByID(e.id);
      }
    });
  }
}

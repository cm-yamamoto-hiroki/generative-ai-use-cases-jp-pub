import { produce } from 'immer';
import { create } from 'zustand';
import {
  ShownMessage,
  RecordedMessage,
  UnrecordedMessage,
  ToBeRecordedMessage,
  Chat,
  ListChatsResponse,
  Role,
} from 'generative-ai-use-cases-jp';
import { useEffect, useMemo } from 'react';
import { v4 as uuid } from 'uuid';
import useChatApi from './useChatApi';
import useConversation from './useConversation';
import { KeyedMutator } from 'swr';
import { getPrompter } from '../prompts';
import { findModelByModelId } from './useModel';

const useChatState = create<{
  chats: {
    [id: string]: {
      chat?: Chat;
      messages: ShownMessage[];
    };
  };
  modelIds: {
    [id: string]: string;
  };
  loading: {
    [id: string]: boolean;
  };
  getModelId: (id: string) => string;
  setModelId: (id: string, newModelId: string) => void;
  setLoading: (id: string, newLoading: boolean) => void;
  init: (id: string) => void;
  clear: (id: string) => void;
  restore: (id: string, messages: RecordedMessage[], chat: Chat) => void;
  updateSystemContext: (id: string, systemContext: string) => void;
  getCurrentSystemContext: (id: string) => string;
  pushMessage: (id: string, role: Role, content: string) => void;
  popMessage: (id: string) => ShownMessage | undefined;
  post: (
    id: string,
    content: string,
    mutateListChat: KeyedMutator<ListChatsResponse>,
    ignoreHistory: boolean,
    preProcessInput: ((message: ShownMessage[]) => ShownMessage[]) | undefined,
    postProcessOutput: ((message: string) => string) | undefined,
    extraSuffix: string | undefined,
    stopSequences: string[] | undefined,
    sessionId: string | undefined
  ) => void;
  sendFeedback: (
    id: string,
    createdDate: string,
    feedback: string
  ) => Promise<void>;
}>((set, get) => {
  const {
    createChat,
    createMessages,
    updateFeedback,
    predictStream,
    predictTitle,
  } = useChatApi();

  const getModelId = (id: string) => {
    return get().modelIds[id] || '';
  };

  const setModelId = (id: string, newModelId: string) => {
    set((state) => {
      return {
        modelIds: {
          ...state.modelIds,
          [id]: newModelId,
        },
      };
    });
  };

  const setLoading = (id: string, newLoading: boolean) => {
    set((state) => {
      return {
        loading: {
          ...state.loading,
          [id]: newLoading,
        },
      };
    });
  };

  const initChat = (id: string, messages: UnrecordedMessage[], chat?: Chat) => {
    set((state) => {
      return {
        chats: produce(state.chats, (draft) => {
          draft[id] = {
            chat,
            messages,
          };
        }),
      };
    });
  };

  const initChatWithSystemContext = (id: string) => {
    const prompter = getPrompter(getModelId(id));
    const systemContext = prompter.systemContext(id);

    initChat(id, [{ role: 'system', content: systemContext }], undefined);
  };

  const setTitle = (id: string, title: string) => {
    set((state) => {
      return {
        chats: produce(state.chats, (draft) => {
          if (draft[id].chat) {
            draft[id].chat!.title = title;
          }
        }),
      };
    });
  };

  const setPredictedTitle = async (id: string) => {
    const title = await predictTitle({
      chat: get().chats[id].chat!,
      messages: omitUnusedMessageProperties(get().chats[id].messages),
    });
    setTitle(id, title);
  };

  const createChatIfNotExist = async (
    id: string,
    chat?: Chat
  ): Promise<string> => {
    if (chat) {
      return chat.chatId;
    }

    const { chat: newChat } = await createChat();

    set((state) => {
      const newChats = produce(state.chats, (draft) => {
        draft[id].chat = newChat;
      });

      return {
        chats: newChats,
      };
    });

    return newChat.chatId;
  };

  const addMessageIdsToUnrecordedMessages = (
    id: string
  ): ToBeRecordedMessage[] => {
    const toBeRecordedMessages: ToBeRecordedMessage[] = [];

    set((state) => {
      const newChats = produce(state.chats, (draft) => {
        for (const m of draft[id].messages) {
          if (!m.messageId) {
            m.messageId = uuid();
            const match = id.match(/([^/]+)/);
            if (match) {
              m.usecase = '/' + match[1];
            } else {
              m.usecase = id;
            }
            // 参照が切れるとエラーになるため clone する
            toBeRecordedMessages.push(
              Object.assign({}, m as ToBeRecordedMessage)
            );
          }
        }
      });

      return {
        chats: newChats,
      };
    });

    return toBeRecordedMessages;
  };

  const replaceMessages = (id: string, messages: RecordedMessage[]) => {
    set((state) => {
      const newChats = produce(state.chats, (draft) => {
        for (const m of messages) {
          const idx = draft[id].messages
            .map((_m: ShownMessage) => _m.messageId)
            .indexOf(m.messageId);

          if (idx >= 0) {
            draft[id].messages[idx] = m;
          }
        }
      });

      return {
        chats: newChats,
      };
    });
  };

  const omitUnusedMessageProperties = (
    messages: ShownMessage[]
  ): UnrecordedMessage[] => {
    return messages.map((m) => {
      return {
        role: m.role,
        content: m.content,
      };
    });
  };

  return {
    chats: {},
    modelIds: {},
    loading: {},
    getModelId,
    setModelId,
    setLoading,
    init: (id: string) => {
      if (!get().chats[id]) {
        initChatWithSystemContext(id);
      }
    },
    clear: (id: string) => {
      initChatWithSystemContext(id);
    },
    restore: (id: string, messages: RecordedMessage[], chat: Chat) => {
      for (const [key, value] of Object.entries(get().chats)) {
        if (value.chat?.chatId === chat.chatId) {
          initChatWithSystemContext(key);
        }
      }

      initChat(id, messages, chat);
    },
    updateSystemContext: (id: string, systemContext: string) => {
      set((state) => {
        return {
          chats: produce(state.chats, (draft) => {
            const idx = draft[id].messages.findIndex(
              (m) => m.role === 'system'
            );
            if (idx > -1) {
              draft[id].messages[idx].content = systemContext;
            }
          }),
        };
      });
    },
    getCurrentSystemContext: (id: string) => {
      const chat = get().chats[id];

      if (chat) {
        return chat.messages.filter((message) => message.role === 'system')[0]
          .content;
      }

      return '';
    },
    pushMessage: (id: string, role: Role, content: string) => {
      set((state) => {
        return {
          chats: produce(state.chats, (draft) => {
            draft[id].messages.push({
              role,
              content,
            });
          }),
        };
      });
    },
    popMessage: (id: string) => {
      let ret: ShownMessage | undefined;
      set((state) => {
        ret = state.chats[id].messages[state.chats[id].messages.length - 1];
        return {
          chats: produce(state.chats, (draft) => {
            draft[id].messages.pop();
          }),
        };
      });
      return ret;
    },
    post: async (
      id: string,
      content: string,
      mutateListChat,
      ignoreHistory: boolean,
      preProcessInput:
        | ((message: ShownMessage[]) => ShownMessage[])
        | undefined = undefined,
      postProcessOutput: ((message: string) => string) | undefined = undefined,
      extraSuffix: string | undefined = undefined,
      stopSequences: string[] | undefined = undefined,
      sessionId: string | undefined = undefined
    ) => {
      const modelId = get().modelIds[id];

      if (!modelId) {
        console.error('modelId is not set');
        return;
      }

      const model = findModelByModelId(modelId);

      if (!model) {
        console.error(`model not found for ${modelId}`);
        return;
      }

      // Agent 用の対応
      if (sessionId) {
        model.sessionId = sessionId;
      }

      setLoading(id, true);

      const unrecordedUserMessage: UnrecordedMessage = {
        role: 'user',
        content,
      };

      const unrecordedAssistantMessage: UnrecordedMessage = {
        role: 'assistant',
        content: '',
      };

      // User/Assistant の発言を反映
      set((state) => {
        const newChats = produce(state.chats, (draft) => {
          draft[id].messages.push(unrecordedUserMessage);
          draft[id].messages.push(unrecordedAssistantMessage);
        });

        return {
          chats: newChats,
        };
      });

      const chatMessages = get().chats[id].messages;

      // 最後のメッセージはアシスタントのメッセージなので、排除
      // ignoreHistory が設定されている場合は最後の会話だけ反映（コスト削減）
      let inputMessages = ignoreHistory
        ? [chatMessages[0], ...chatMessages.slice(-2, -1)]
        : chatMessages.slice(0, -1);

      // メッセージの前処理（例：ログからの footnote の削除）
      if (preProcessInput) {
        inputMessages = preProcessInput(inputMessages);
      }

      // LLM へのリクエスト
      const stream = predictStream({
        model: model,
        messages: omitUnusedMessageProperties(inputMessages),
        extraSuffix: extraSuffix,
        stopSequences: stopSequences,
      });

      // Assistant の発言を更新
      for await (const chunk of stream) {
        set((state) => {
          const newChats = produce(state.chats, (draft) => {
            const oldAssistantMessage = draft[id].messages.pop()!;
            const newAssistantMessage: UnrecordedMessage = {
              role: 'assistant',
              content: (oldAssistantMessage.content + chunk).replace(
                /(<output>|<\/output>)/g,
                ''
              ),
              llmType: model?.modelId,
            };
            draft[id].messages.push(newAssistantMessage);
          });
          return {
            chats: newChats,
          };
        });
      }

      // メッセージの後処理（例：footnote の付与）
      if (postProcessOutput) {
        set((state) => {
          const newChats = produce(state.chats, (draft) => {
            const oldAssistantMessage = draft[id].messages.pop()!;
            const newAssistantMessage: UnrecordedMessage = {
              role: 'assistant',
              content: postProcessOutput(oldAssistantMessage.content),
              llmType: model?.modelId,
            };
            draft[id].messages.push(newAssistantMessage);
          });
          return {
            chats: newChats,
          };
        });
      }

      setLoading(id, false);

      const chatId = await createChatIfNotExist(id, get().chats[id].chat);

      // タイトルが空文字列だった場合、タイトルを予測して設定
      if (get().chats[id].chat?.title === '') {
        setPredictedTitle(id).then(() => {
          mutateListChat();
        });
      }

      const toBeRecordedMessages = addMessageIdsToUnrecordedMessages(id);
      const { messages } = await createMessages(chatId, {
        messages: toBeRecordedMessages,
      });

      replaceMessages(id, messages);
    },

    sendFeedback: async (id: string, createdDate: string, feedback: string) => {
      const chat = get().chats[id].chat;

      if (chat) {
        const { message } = await updateFeedback(chat.chatId, {
          createdDate,
          feedback,
        });
        replaceMessages(id, [message]);
      }
    },
  };
});

/**
 * チャットを操作する Hooks
 * @param id 画面の URI（状態の識別に利用）
 * @param systemContext
 * @param chatId
 * @returns
 */
const useChat = (id: string, chatId?: string) => {
  const {
    chats,
    loading,
    getModelId,
    setModelId,
    setLoading,
    init,
    clear,
    restore,
    post,
    sendFeedback,
    updateSystemContext,
    getCurrentSystemContext,
    pushMessage,
    popMessage,
  } = useChatState();
  const { data: messagesData, isLoading: isLoadingMessage } =
    useChatApi().listMessages(chatId);
  const { data: chatData, isLoading: isLoadingChat } =
    useChatApi().findChatById(chatId);
  const { mutate: mutateConversations } = useConversation();

  useEffect(() => {
    // 新規チャットの場合
    if (!chatId) {
      init(id);
    }
  }, [init, id, chatId]);

  useEffect(() => {
    // 登録済みのチャットの場合
    if (!isLoadingMessage && messagesData && !isLoadingChat && chatData) {
      restore(id, messagesData.messages, chatData.chat);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoadingMessage, isLoadingChat]);

  const filteredMessages = useMemo(() => {
    return chats[id]?.messages.filter((chat) => chat.role !== 'system') ?? [];
  }, [chats, id]);

  return {
    loading: loading[id] ?? false,
    getModelId: () => {
      return getModelId(id);
    },
    setModelId: (newModelId: string) => {
      setModelId(id, newModelId);
    },
    setLoading: (newLoading: boolean) => {
      setLoading(id, newLoading);
    },
    loadingMessages: isLoadingMessage,
    init: () => {
      init(id);
    },
    clear: () => {
      clear(id);
    },
    updateSystemContext: (systemContext: string) => {
      updateSystemContext(id, systemContext);
    },
    getCurrentSystemContext: () => {
      return getCurrentSystemContext(id);
    },
    pushMessage: (role: Role, content: string) =>
      pushMessage(id, role, content),
    popMessage: () => popMessage(id),
    rawMessages: chats[id]?.messages ?? [],
    messages: filteredMessages,
    isEmpty: filteredMessages.length === 0,
    postChat: (
      content: string,
      ignoreHistory: boolean = false,
      preProcessInput:
        | ((message: ShownMessage[]) => ShownMessage[])
        | undefined = undefined,
      postProcessOutput: ((message: string) => string) | undefined = undefined,
      extraSuffix: string | undefined = undefined,
      stopSequences: string[] | undefined = undefined,
      sessionId: string | undefined = undefined
    ) => {
      post(
        id,
        content,
        mutateConversations,
        ignoreHistory,
        preProcessInput,
        postProcessOutput,
        extraSuffix,
        stopSequences,
        sessionId
      );
    },
    sendFeedback: async (createdDate: string, feedback: string) => {
      await sendFeedback(id, createdDate, feedback);
    },
  };
};

export default useChat;

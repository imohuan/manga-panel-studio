/* ============================================================
   kit.js — UI-Kit 组件库 (Vue 3 + Material 3 黑白风格)
   风格参考: model-search-debug.html
   ------------------------------------------------------------
   使用方式:
     <script src="/vendor/vue.global.prod.js"></script>
     <script src="kit.js"></script>
     <script>
       const app = Vue.createApp({ ... });
       app.use(UIKit);
       app.mount('#app');
     </script>
   在模板中可用:
     全局组件 <kit-button> <kit-input> <kit-dialog> ...
     全局服务  $toast, $confirm, $dialog
     指令      v-tooltip="'提示文字'"
   ============================================================ */

(function (global) {
  'use strict';

  const ICONS = {
    info: 'info',
    success: 'check_circle',
    error: 'error',
    warning: 'warning',
  };

  /* ---------- 工具 ---------- */
  function uid() {
    return 'kit-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /* ---------- 表单基础组件 ---------- */

  const KitButton = {
    name: 'KitButton',
    props: {
      variant: { type: String, default: 'filled' }, // filled | outlined | text | tonal | error
      size: { type: String, default: 'md' },         // sm | md | lg
      icon: String,
      disabled: Boolean,
      loading: Boolean,
      type: { type: String, default: 'button' },
    },
    emits: ['click'],
    template: `
      <button :type="type" :disabled="disabled || loading"
        class="kit-btn" :class="['kit-btn--' + variant, size === 'sm' ? 'kit-btn--sm' : size === 'lg' ? 'kit-btn--lg' : '']"
        @click="$emit('click', $event)">
        <span v-if="loading" class="spinner material-symbols-outlined icon-sm">progress_activity</span>
        <span v-else-if="icon" class="material-symbols-outlined icon-sm">{{ icon }}</span>
        <slot></slot>
      </button>
    `,
  };

  const KitIconButton = {
    name: 'KitIconButton',
    props: {
      icon: { type: String, required: true },
      size: { type: String, default: 'md' }, // sm | md
      danger: Boolean,
      disabled: Boolean,
      title: String,
    },
    emits: ['click'],
    template: `
      <button class="kit-icon-btn" :class="{ 'kit-icon-btn--sm': size === 'sm', 'kit-icon-btn--danger': danger }"
        :disabled="disabled" :title="title" @click="$emit('click', $event)">
        <span class="material-symbols-outlined">{{ icon }}</span>
      </button>
    `,
  };

  const KitInput = {
    name: 'KitInput',
    props: {
      modelValue: [String, Number],
      type: { type: String, default: 'text' },
      placeholder: String,
      size: { type: String, default: 'md' }, // sm | md | lg
      mono: Boolean,
      disabled: Boolean,
      readonly: Boolean,
      invalid: Boolean,
      icon: String,          // 左侧图标
      prefix: String,        // 左侧文字前缀
      suffix: String,        // 右侧文字后缀
      passwordToggle: Boolean, // 密码可见切换
    },
    emits: ['update:modelValue', 'enter', 'focus', 'blur'],
    data() {
      return { showPwd: false };
    },
    computed: {
      inputType() {
        if (this.type === 'password' && this.passwordToggle) return this.showPwd ? 'text' : 'password';
        return this.type;
      },
    },
    methods: {
      onInput(e) { this.$emit('update:modelValue', e.target.value); },
      onKeydown(e) { if (e.key === 'Enter') this.$emit('enter', e); },
    },
    template: `
      <div class="kit-input-wrap w-full" :class="{ 'kit-input-wrap--right': icon && type === 'password' && !passwordToggle }">
        <span v-if="icon && type !== 'password'" class="kit-icon material-symbols-outlined">{{ icon }}</span>
        <input
          class="kit-input" :class="[
            'kit-input--' + size,
            { 'kit-input--mono': mono, 'kit-input--invalid': invalid,
              'kit-input--has-prefix': prefix, 'kit-input--has-suffix': suffix,
              'kit-input--has-toggle': passwordToggle }]"
          :type="inputType" :value="modelValue" :placeholder="placeholder"
          :disabled="disabled" :readonly="readonly"
          @input="onInput" @keydown="onKeydown" @focus="$emit('focus', $event)" @blur="$emit('blur', $event)">
        <span v-if="prefix" class="kit-input-affix kit-input-affix--prefix">{{ prefix }}</span>
        <span v-if="suffix" class="kit-input-affix kit-input-affix--suffix">{{ suffix }}</span>
        <button v-if="passwordToggle" type="button" class="kit-input-toggle" @click="showPwd = !showPwd">
          <span class="material-symbols-outlined">{{ showPwd ? 'visibility' : 'visibility_off' }}</span>
        </button>
      </div>
    `,
  };

  const KitTextarea = {
    name: 'KitTextarea',
    props: {
      modelValue: String,
      placeholder: String,
      rows: { type: Number, default: 3 },
      mono: Boolean,
      disabled: Boolean,
      invalid: Boolean,
      resize: { type: String, default: 'vertical' }, // none | vertical | both
    },
    emits: ['update:modelValue'],
    methods: {
      onInput(e) { this.$emit('update:modelValue', e.target.value); },
    },
    template: `
      <textarea class="kit-textarea" :class="{ 'kit-textarea--mono': mono, 'kit-input--invalid': invalid }"
        :rows="rows" :value="modelValue" :placeholder="placeholder" :disabled="disabled"
        :style="{ resize }" @input="onInput"></textarea>
    `,
  };

  /* ============================================================
     KitSelect 下拉选择（AxSelect 复刻）
     用法:
       <kit-select v-model="sel" :options="[{label, value}]" placeholder="请选择"/>
       <kit-select v-model="arr" :options="options" multiple searchable/>
     兼容旧用法: <kit-select><option value="x">X</option></kit-select>
     ============================================================ */

  const KitSelect = {
    name: 'KitSelect',
    props: {
      modelValue: [String, Number, Array],
      options: { type: Array, default: () => [] }, // [{label, value, disabled?}]
      placeholder: { type: String, default: '请选择' },
      searchPlaceholder: { type: String, default: '搜索...' },
      searchable: Boolean,
      multiple: Boolean,
      disabled: Boolean,
      mono: Boolean,
      size: { type: String, default: 'md' }, // sm | md | lg
      dropdownWidth: { type: String, default: 'match' }, // match | auto | 具体宽度
      dropdownMaxWidth: { type: String, default: '320px' },
    },
    emits: ['update:modelValue', 'change'],
    data() {
      return {
        open: false,
        searchQuery: '',
        highlightIndex: -1,
        listRef: null,
      };
    },
    computed: {
      /* 从 props.options 或 slot <option> 解析 */
      resolvedOptions() {
        if (this.options.length) return this.options;
        const out = [];
        const slotOpts = this.$slots.default ? this.$slots.default() : [];
        const walk = (vnodes) => {
          for (const v of vnodes) {
            const t = v.type;
            // 原生 <option> 的 type 是 'option'；KitOption 的 name 是 'Option'
            if (t === 'option' || (t && t.name === 'Option')) {
              out.push({
                label: v.children || (v.props && v.props.label) || String(v.props && v.props.value),
                value: v.props && v.props.value,
                disabled: v.props && v.props.disabled,
              });
            } else if (v.children && Array.isArray(v.children)) {
              walk(v.children);
            }
          }
        };
        walk(slotOpts);
        return out;
      },
      selectedValues() {
        if (this.multiple) {
          const mv = this.modelValue;
          if (Array.isArray(mv)) return mv.slice();
          if (mv === '' || mv == null) return [];
          return [mv];
        }
        return this.modelValue !== '' && this.modelValue != null ? [this.modelValue] : [];
      },
      selectedLabels() {
        return this.selectedValues.map(v => {
          const opt = this.resolvedOptions.find(o => o.value === v);
          return opt ? { value: v, label: opt.label } : { value: v, label: String(v) };
        });
      },
      displayLabel() {
        if (this.multiple) return this.selectedLabels.length ? '' : this.placeholder;
        return this.selectedLabels[0]?.label || this.placeholder;
      },
      filteredOptions() {
        const q = this.searchQuery.trim().toLowerCase();
        if (!q) return this.resolvedOptions;
        return this.resolvedOptions.filter(o => String(o.label).toLowerCase().includes(q));
      },
      hasValue() {
        return this.multiple ? this.selectedValues.length > 0 : this.modelValue !== '' && this.modelValue != null;
      },
      isMatchWidth() {
        return this.dropdownWidth === 'match' || this.dropdownWidth === 'auto';
      },
    },
    methods: {
      isSelected(opt) { return this.selectedValues.includes(opt.value); },
      selectOption(opt) {
        if (opt.disabled) return;
        if (this.multiple) {
          const cur = this.selectedValues.slice();
          const idx = cur.indexOf(opt.value);
          if (idx >= 0) cur.splice(idx, 1);
          else cur.push(opt.value);
          this.emitValue(cur);
          this.searchQuery = '';
          this.highlightIndex = -1;
          if (this.$refs.searchInput) this.$refs.searchInput.focus();
        } else {
          this.emitValue(opt.value);
          this.closeDropdown();
        }
      },
      removeOption(value) {
        if (!this.multiple) return;
        this.emitValue(this.selectedValues.filter(v => v !== value));
      },
      emitValue(v) {
        this.$emit('update:modelValue', v);
        this.$emit('change', v);
      },
      handleClear(e) {
        e.stopPropagation();
        this.emitValue(this.multiple ? [] : '');
      },
      onDropdownChange() { /* KitDropdown v-model 同步，无额外逻辑 */ },
      closeDropdown() {
        this.open = false;
        this.searchQuery = '';
        this.highlightIndex = -1;
      },
      toggleDropdown() {
        this.open = !this.open;
        if (this.open && this.searchable) {
          this.$nextTick(() => this.$refs.searchInput && this.$refs.searchInput.focus());
        }
      },
      scrollToHighlight() {
        this.$nextTick(() => {
          const items = this.listRef ? this.listRef.querySelectorAll('[data-option]') : [];
          const el = items[this.highlightIndex];
          if (el) el.scrollIntoView({ block: 'nearest' });
        });
      },
      handleKeydown(e) {
        const len = this.filteredOptions.length;
        if (!len) return;
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            this.highlightIndex = this.highlightIndex < len - 1 ? this.highlightIndex + 1 : 0;
            this.scrollToHighlight();
            break;
          case 'ArrowUp':
            e.preventDefault();
            this.highlightIndex = this.highlightIndex > 0 ? this.highlightIndex - 1 : len - 1;
            this.scrollToHighlight();
            break;
          case 'Enter':
            e.preventDefault();
            if (this.highlightIndex >= 0 && this.highlightIndex < len) {
              this.selectOption(this.filteredOptions[this.highlightIndex]);
            }
            break;
          case 'Escape':
            e.preventDefault();
            this.closeDropdown();
            break;
        }
      },
    },
    template: `
      <kit-dropdown v-model="open" :match-width="isMatchWidth" :menu-max-width="dropdownMaxWidth"
        @update:model-value="onDropdownChange">
        <template #trigger>
          <div @click.stop>
          <div class="kit-select-trigger" :class="['kit-select-trigger--' + size, { 'kit-select-trigger--open': open, 'font-mono': mono }]"
            :disabled="disabled" tabindex="0" role="combobox" aria-haspopup="listbox" :aria-expanded="open"
            @click="!disabled && toggleDropdown()"
            @keydown.enter.prevent="!disabled && toggleDropdown()"
            @keydown.space.prevent="!disabled && toggleDropdown()">
            <!-- 已选标签（多选） -->
            <template v-if="multiple && selectedLabels.length">
              <span v-for="opt in selectedLabels" :key="opt.value" class="kit-select-tag">
                <span class="kit-select-tag-label">{{ opt.label }}</span>
                <button type="button" class="kit-select-tag-remove" @click.stop="removeOption(opt.value)">
                  <span class="material-symbols-outlined">close</span>
                </button>
              </span>
            </template>
            <!-- 搜索模式：打开时显示搜索框 -->
            <input v-else-if="searchable && open" ref="searchInput" v-model="searchQuery" type="text"
              class="kit-select-search-input" :placeholder="selectedLabels.length ? '' : searchPlaceholder"
              autocomplete="off" @click.stop @keydown="handleKeydown">
            <!-- 显示值 -->
            <span v-else :class="hasValue ? 'kit-select-value' : 'kit-select-placeholder'">{{ displayLabel }}</span>
            <!-- 清除按钮 -->
            <span v-if="hasValue && !searchable" style="margin-left:auto" class="flex items-center">
              <button v-if="!multiple" type="button" class="kit-select-tag-remove" @click.stop="handleClear">
                <span class="material-symbols-outlined" style="font-size:14px">close</span>
              </button>
            </span>
            <span class="material-symbols-outlined kit-select-arrow" :class="{ 'kit-select-arrow--open': open }">expand_more</span>
          </div>
          </div>
        </template>
        <template #default>
          <div ref="listRef" class="kit-select-options" @keydown="handleKeydown">
            <button v-for="(opt, index) in filteredOptions" :key="opt.value" type="button" data-option
              class="kit-select-option"
              :class="[
                !multiple && selectedValues[0] === opt.value ? 'kit-select-option--selected'
                  : highlightIndex === index ? 'kit-select-option--highlighted'
                  : multiple && isSelected(opt) ? 'kit-select-option--multi-selected' : '',
              ]"
              :disabled="opt.disabled"
              @click="selectOption(opt)" @mouseenter="highlightIndex = index">
              <span v-if="multiple" class="kit-select-checkbox" :class="isSelected(opt) ? 'kit-select-checkbox--checked' : ''">
                <span v-if="isSelected(opt)" class="material-symbols-outlined">check</span>
              </span>
              <span class="kit-select-tag-label">{{ opt.label }}</span>
              <span v-if="!multiple && selectedValues[0] === opt.value" class="material-symbols-outlined" style="margin-left:auto">check</span>
            </button>
            <div v-if="filteredOptions.length === 0" class="kit-select-no-results">无匹配选项</div>
          </div>
        </template>
      </kit-dropdown>
    `,
  };

  /* 兼容 slot 用法的原生 option 注册（KitSelect 内部识别） */
  const KitOption = {
    name: 'Option',
    props: { value: { required: true }, label: String, disabled: Boolean },
    render() { return null; },
  };

  const KitCheckbox = {
    name: 'KitCheckbox',
    props: {
      modelValue: Boolean,
      label: String,
      disabled: Boolean,
      value: { default: undefined }, // 数组 v-model 用法
    },
    emits: ['update:modelValue', 'change'],
    template: `
      <label class="kit-checkbox-label" :class="{ 'opacity-50': disabled }">
        <input type="checkbox" class="kit-checkbox" :disabled="disabled"
          :checked="modelValue" @change="$emit('update:modelValue', $event.target.checked); $emit('change', $event.target.checked)">
        <span v-if="label">{{ label }}</span>
        <slot></slot>
      </label>
    `,
  };

  const KitRadio = {
    name: 'KitRadio',
    props: {
      modelValue: [String, Number, Boolean],
      label: String,
      value: { required: true },
      disabled: Boolean,
      name: String,
    },
    emits: ['update:modelValue'],
    template: `
      <label class="kit-radio-label" :class="{ 'opacity-50': disabled }">
        <input type="radio" class="kit-radio" :name="name" :value="value" :disabled="disabled"
          :checked="modelValue === value"
          @change="$emit('update:modelValue', value)">
        <span v-if="label">{{ label }}</span>
        <slot></slot>
      </label>
    `,
  };

  const KitSwitch = {
    name: 'KitSwitch',
    props: {
      modelValue: Boolean,
      label: String,
      disabled: Boolean,
      size: { type: String, default: 'md' }, // sm | md | lg
    },
    emits: ['update:modelValue', 'change'],
    template: `
      <label class="kit-switch-label" :class="{ 'opacity-50': disabled }">
        <span class="kit-switch" :class="'kit-switch--' + size">
          <input type="checkbox" :checked="modelValue" :disabled="disabled"
            @change="$emit('update:modelValue', $event.target.checked); $emit('change', $event.target.checked)">
          <span class="kit-switch__track"></span>
        </span>
        <span v-if="label">{{ label }}</span>
        <slot></slot>
      </label>
    `,
  };

  const KitSlider = {
    name: 'KitSlider',
    props: {
      modelValue: Number,
      min: { type: Number, default: 0 },
      max: { type: Number, default: 100 },
      step: { type: Number, default: 1 },
      disabled: Boolean,
    },
    emits: ['update:modelValue'],
    template: `
      <div class="kit-slider-row">
        <input type="range" class="kit-slider" :min="min" :max="max" :step="step" :disabled="disabled"
          :value="modelValue" @input="$emit('update:modelValue', Number($event.target.value))">
        <span class="kit-slider-value">{{ modelValue }}</span>
      </div>
    `,
  };

  const KitChip = {
    name: 'KitChip',
    props: {
      variant: { type: String, default: 'outline' }, // outline | filled | tonal
      closable: Boolean,
      selectable: Boolean,
      selected: Boolean,
    },
    emits: ['close', 'select'],
    template: `
      <span class="kit-chip" :class="[
        'kit-chip--' + (selected && variant === 'outline' ? 'filled' : variant),
        { 'kit-chip--selectable': selectable }]"
        @click="selectable && $emit('select')">
        <slot></slot>
        <button v-if="closable" type="button" class="kit-chip__close material-symbols-outlined"
          @click.stop="$emit('close')">close</button>
      </span>
    `,
  };

  const KitBadge = {
    name: 'KitBadge',
    props: {
      variant: { type: String, default: 'neutral' }, // ok | error | neutral | primary | warning | info
    },
    template: `<span class="kit-badge" :class="'kit-badge--' + variant"><slot></slot></span>`,
  };

  const KitStatusDot = {
    name: 'KitStatusDot',
    props: {
      status: { type: String, default: 'pending' }, // pending | running | ok | error | warning | info
    },
    template: `<span class="kit-status-dot" :class="'kit-status-dot--' + status"></span>`,
  };

  const KitField = {
    name: 'KitField',
    props: {
      label: String,
      icon: String,
      hint: String,
      error: String,
      required: Boolean,
    },
    template: `
      <div class="kit-field">
        <label v-if="label" class="kit-field__label">
          <span v-if="icon" class="material-symbols-outlined">{{ icon }}</span>
          <span>{{ label }}</span>
          <span v-if="required" class="text-error">*</span>
        </label>
        <slot></slot>
        <span v-if="error" class="kit-field__error">
          <span class="material-symbols-outlined icon-xs">error</span>{{ error }}
        </span>
        <span v-else-if="hint" class="kit-field__hint">{{ hint }}</span>
      </div>
    `,
  };

  const KitSegmented = {
    name: 'KitSegmented',
    props: {
      modelValue: [String, Number],
      options: { type: Array, required: true }, // [{label, value, icon?}]
    },
    emits: ['update:modelValue'],
    template: `
      <div class="kit-segmented">
        <button v-for="opt in options" :key="opt.value" type="button"
          class="kit-segmented__item" :class="{ 'kit-segmented__item--active': modelValue === opt.value }"
          @click="$emit('update:modelValue', opt.value)">
          <span v-if="opt.icon" class="material-symbols-outlined icon-xs">{{ opt.icon }}</span>
          {{ opt.label }}
        </button>
      </div>
    `,
  };

  const KitTagInput = {
    name: 'KitTagInput',
    props: {
      modelValue: { type: Array, default: () => [] },
      placeholder: String,
      disabled: Boolean,
    },
    emits: ['update:modelValue'],
    data() { return { draft: '' }; },
    methods: {
      add() {
        const v = this.draft.trim();
        if (v && !this.modelValue.includes(v)) {
          this.$emit('update:modelValue', [...this.modelValue, v]);
        }
        this.draft = '';
      },
      remove(tag) {
        this.$emit('update:modelValue', this.modelValue.filter(t => t !== tag));
      },
      onKeydown(e) {
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.add(); }
        else if (e.key === 'Backspace' && !this.draft && this.modelValue.length) {
          this.remove(this.modelValue[this.modelValue.length - 1]);
        }
      },
    },
    template: `
      <div class="kit-tag-input">
        <span v-for="tag in modelValue" :key="tag" class="kit-tag-input__tag">
          {{ tag }}
          <span class="material-symbols-outlined" @click="remove(tag)">close</span>
        </span>
        <input v-model="draft" :placeholder="placeholder" :disabled="disabled"
          @keydown="onKeydown" @blur="add">
      </div>
    `,
  };

  /* ---------- 反馈组件 ---------- */

  const KitDialog = {
    name: 'KitDialog',
    props: {
      modelValue: Boolean,
      title: String,
      icon: String,
      size: { type: String, default: 'md' }, // sm | md | lg
      showClose: { type: Boolean, default: true },
      showFooter: { type: Boolean, default: true },
      closeOnOverlay: { type: Boolean, default: true },
    },
    emits: ['update:modelValue', 'close'],
    methods: {
      close() { this.$emit('update:modelValue', false); this.$emit('close'); },
      onOverlay(e) { if (this.closeOnOverlay && e.target === e.currentTarget) this.close(); },
    },
    template: `
      <teleport to="body">
        <transition name="fade">
          <div v-if="modelValue" class="kit-overlay" @click.self="onOverlay">
            <transition name="pop" appear>
              <div class="kit-dialog" :class="'kit-dialog--' + size" role="dialog" aria-modal="true">
                <div v-if="title" class="kit-dialog__header">
                  <span class="kit-dialog__title">
                    <span v-if="icon" class="material-symbols-outlined">{{ icon }}</span>
                    {{ title }}
                  </span>
                  <kit-icon-button v-if="showClose" icon="close" size="sm" @click="close()"></kit-icon-button>
                </div>
                <div class="kit-dialog__body"><slot></slot></div>
                <div v-if="showFooter || $slots.footer" class="kit-dialog__footer">
                  <slot name="footer">
                    <kit-button variant="outlined" @click="close()">关闭</kit-button>
                  </slot>
                </div>
              </div>
            </transition>
          </div>
        </transition>
      </teleport>
    `,
  };

  const KitConfirm = {
    name: 'KitConfirm',
    props: {
      modelValue: Boolean,
      title: { type: String, default: '确认操作' },
      message: String,
      type: { type: String, default: 'warning' }, // warning | danger | info
      confirmText: { type: String, default: '确认' },
      cancelText: { type: String, default: '取消' },
    },
    emits: ['update:modelValue', 'confirm', 'cancel'],
    methods: {
      onConfirm() { this.$emit('confirm'); this.$emit('update:modelValue', false); },
      onCancel() { this.$emit('cancel'); this.$emit('update:modelValue', false); },
    },
    computed: {
      iconName() {
        return { warning: 'warning', danger: 'delete', info: 'info' }[this.type] || 'warning';
      },
    },
    template: `
      <teleport to="body">
        <transition name="fade">
          <div v-if="modelValue" class="kit-overlay" @click.self="onCancel">
            <transition name="pop" appear>
              <div class="kit-dialog kit-dialog--sm" role="alertdialog" aria-modal="true">
                <div class="kit-dialog__body flex items-start gap-3 p-4">
                  <span class="kit-confirm-icon" :class="'kit-confirm-icon--' + type">
                    <span class="material-symbols-outlined">{{ iconName }}</span>
                  </span>
                  <div class="flex-1">
                    <div class="font-semibold text-sm text-on-surface mb-1">{{ title }}</div>
                    <div class="text-xs text-on-surface-variant leading-relaxed">{{ message }}</div>
                    <slot></slot>
                  </div>
                </div>
                <div class="kit-dialog__footer">
                  <kit-button variant="outlined" @click="onCancel">{{ cancelText }}</kit-button>
                  <kit-button :variant="type === 'danger' ? 'error' : 'filled'" @click="onConfirm">{{ confirmText }}</kit-button>
                </div>
              </div>
            </transition>
          </div>
        </transition>
      </teleport>
    `,
  };

  /* ---------- Toast / Notify ---------- */

  const KitToastHost = {
    name: 'KitToastHost',
    data() {
      return { toasts: [] };
    },
    methods: {
      add(options) {
        const id = uid();
        const toast = {
          id,
          type: options.type || 'info',
          message: options.message || '',
          duration: options.duration != null ? options.duration : 3000,
          icon: options.icon || ICONS[options.type || 'info'],
        };
        this.toasts.push(toast);
        if (toast.duration > 0) {
          setTimeout(() => this.remove(id), toast.duration);
        }
        return id;
      },
      remove(id) {
        const idx = this.toasts.findIndex(t => t.id === id);
        if (idx >= 0) this.toasts.splice(idx, 1);
      },
    },
    template: `
      <div class="kit-toast-container">
        <transition-group name="kit-toast">
          <div v-for="t in toasts" :key="t.id" class="kit-toast" :class="'kit-toast--' + t.type">
            <span class="kit-toast__icon material-symbols-outlined">{{ t.icon }}</span>
            <span class="flex-1 min-w-0">{{ t.message }}</span>
            <button class="kit-toast__close" @click="remove(t.id)">
              <span class="material-symbols-outlined icon-xs">close</span>
            </button>
          </div>
        </transition-group>
      </div>
    `,
  };

  const KitTooltip = {
    name: 'KitTooltip',
    props: {
      text: String,
      placement: { type: String, default: 'top' }, // top | bottom | left | right
    },
    data() {
      return { visible: false, x: 0, y: 0 };
    },
    methods: {
      show(e) {
        this.visible = true;
        this.$nextTick(() => this.position(e.currentTarget));
      },
      hide() { this.visible = false; },
      position(el) {
        const rect = el.getBoundingClientRect();
        const tip = this.$refs.tip;
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        const gap = 6;
        const pos = { top: rect.top - th - gap, bottom: rect.bottom + gap, left: rect.left, right: rect.right };
        const x = { top: rect.left + rect.width / 2 - tw / 2, bottom: rect.left + rect.width / 2 - tw / 2, left: rect.left - tw - gap, right: rect.right + gap }[this.placement];
        const y = { top: pos.top, bottom: pos.bottom, left: rect.top + rect.height / 2 - th / 2, right: rect.top + rect.height / 2 - th / 2 }[this.placement];
        // 边界修正
        this.x = Math.max(4, Math.min(x, window.innerWidth - tw - 4));
        this.y = Math.max(4, y);
      },
    },
    template: `
      <span class="inline-flex" @mouseenter="show" @mouseleave="hide">
        <slot></slot>
        <span ref="tip" class="kit-tooltip" :class="{ 'kit-tooltip--visible': visible }"
          :style="{ left: x + 'px', top: y + 'px' }">{{ text }}</span>
      </span>
    `,
  };

  /* ---------- 指令: v-tooltip ---------- */

  const vTooltip = {
    mounted(el, binding) {
      const text = binding.value;
      if (!text) return;
      const tip = document.createElement('span');
      tip.className = 'kit-tooltip';
      tip.textContent = text;
      document.body.appendChild(tip);
      const show = () => {
        tip.classList.add('kit-tooltip--visible');
        const rect = el.getBoundingClientRect();
        tip.style.left = rect.left + rect.width / 2 - tip.offsetWidth / 2 + 'px';
        tip.style.top = rect.top - tip.offsetHeight - 6 + 'px';
      };
      const hide = () => tip.classList.remove('kit-tooltip--visible');
      el.addEventListener('mouseenter', show);
      el.addEventListener('mouseleave', hide);
      el._kitTip = { tip, show, hide };
    },
    updated(el, binding) {
      if (el._kitTip) el._kitTip.tip.textContent = binding.value || '';
    },
    unmounted(el) {
      if (el._kitTip) {
        el.removeEventListener('mouseenter', el._kitTip.show);
        el.removeEventListener('mouseleave', el._kitTip.hide);
        el._kitTip.tip.remove();
        el._kitTip = null;
      }
    },
  };

  /* ---------- Dropdown 下拉（AxDropdown 复刻） ---------- */

  const KitDropdown = {
    name: 'KitDropdown',
    props: {
      modelValue: Boolean,
      items: { type: Array, default: () => [] }, // [{label, value, icon?, danger?, disabled?}]
      placement: { type: String, default: 'bottom-start' }, // bottom-start | bottom-end | top-start | top-end
      offset: { type: Number, default: 4 },
      matchWidth: Boolean,          // 面板宽度与触发器一致
      menuWidth: String,
      menuMaxWidth: String,
      trigger: { type: String, default: 'click' }, // click | hover | contextmenu
      hoverCloseDelay: { type: Number, default: 150 },
      teleport: { type: Boolean, default: true },
    },
    emits: ['update:modelValue', 'select'],
    data() {
      return { isOpen: this.modelValue, pos: { left: 0, top: 0 }, positioned: false, closeTimer: null };
    },
    watch: {
      modelValue(v) { this.isOpen = v; },
      isOpen(v) { this.$emit('update:modelValue', v); },
    },
    computed: {
      triggerEvents() {
        const self = this;
        if (this.trigger === 'hover') {
          return {
            onMouseenter: () => this.open(),
            onMouseleave: () => this.scheduleClose(),
          };
        }
        if (this.trigger === 'contextmenu') {
          return { onContextmenu: (e) => { e.preventDefault(); this.open(); } };
        }
        return { onClick: () => this.toggle() };
      },
      panelEvents() {
        if (this.trigger !== 'hover') return {};
        const self = this;
        return {
          onMouseenter: () => this.clearCloseTimer(),
          onMouseleave: () => this.close(),
        };
      },
    },
    methods: {
      open() { this.clearCloseTimer(); this.isOpen = true; },
      close() { this.clearCloseTimer(); this.isOpen = false; },
      toggle() { this.isOpen ? this.close() : this.open(); },
      clearCloseTimer() {
        if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
      },
      scheduleClose() {
        this.clearCloseTimer();
        this.closeTimer = setTimeout(() => this.close(), this.hoverCloseDelay);
      },
      onClickOutside(e) {
        if (!this.isOpen) return;
        const el = this.$refs.container;
        const menu = this.$refs.menu;
        if (el && el.contains(e.target)) return;
        if (menu && menu.contains(e.target)) return;
        this.close();
      },
      onKeydown(e) {
        if (e.key === 'Escape' && this.isOpen) this.close();
      },
      onSelect(item) {
        if (item.disabled) return;
        this.$emit('select', item.value, item);
        this.close();
      },
      positionMenu() {
        const trigger = this.$refs.trigger;
        const menu = this.$refs.menu;
        if (!trigger || !menu) return;
        const tr = trigger.getBoundingClientRect();
        const mr = menu.getBoundingClientRect();
        const gap = this.offset;
        let left, top;
        const alignEnd = this.placement.endsWith('end');
        const alignTop = this.placement.startsWith('top');
        if (this.matchWidth) {
          left = tr.left;
          menu.style.minWidth = tr.width + 'px';
        } else if (alignEnd) {
          left = tr.right - mr.width;
        } else {
          left = tr.left;
        }
        top = alignTop ? tr.top - mr.height - gap : tr.bottom + gap;
        // 视口边界修正
        left = Math.max(4, Math.min(left, window.innerWidth - mr.width - 4));
        if (top < 4) top = tr.bottom + gap;
        if (top + mr.height > window.innerHeight - 4) top = tr.top - mr.height - gap;
        this.pos = { left: Math.round(left), top: Math.round(top) };
        this.positioned = true;
      },
    },
    mounted() {
      document.addEventListener('mousedown', this.onClickOutside);
      document.addEventListener('keydown', this.onKeydown);
      this.$nextTick(() => this.positionMenu());
    },
    updated() {
      if (this.isOpen) this.$nextTick(() => this.positionMenu());
    },
    beforeUnmount() {
      document.removeEventListener('mousedown', this.onClickOutside);
      document.removeEventListener('keydown', this.onKeydown);
      this.clearCloseTimer();
    },
    template: `
      <span ref="container" class="kit-dropdown-base">
        <span ref="trigger" v-bind="triggerEvents"><slot name="trigger" :open="isOpen" :toggle="toggle" :close="close"></slot></span>
        <teleport to="body" :disabled="!teleport">
          <transition name="kit-dropdown">
            <div v-if="isOpen" ref="menu" class="kit-dropdown-menu" :style="{
              position: 'fixed',
              left: pos.left + 'px',
              top: pos.top + 'px',
              minWidth: menuWidth || undefined,
              maxWidth: menuMaxWidth || undefined,
              visibility: positioned ? 'visible' : 'hidden',
            }" v-bind="panelEvents" role="menu">
              <template v-if="items.length">
                <template v-for="(item, i) in items" :key="item.value || i">
                  <div v-if="item.divider" class="kit-dropdown-divider"></div>
                  <button v-else type="button" class="kit-dropdown-item"
                    :class="{ 'kit-dropdown-item--danger': item.danger, 'kit-dropdown-item--active': item.active }"
                    :disabled="item.disabled" @click="onSelect(item)">
                    <span v-if="item.icon" class="material-symbols-outlined">{{ item.icon }}</span>
                    {{ item.label }}
                  </button>
                </template>
              </template>
              <slot :close="close"></slot>
            </div>
          </transition>
        </teleport>
      </span>
    `,
  };

  /* ---------- Tabs ---------- */

  const KitTabs = {
    name: 'KitTabs',
    props: {
      modelValue: [String, Number],
      tabs: { type: Array, required: true }, // [{label, value, icon?}]
    },
    emits: ['update:modelValue'],
    template: `
      <div class="kit-tabs">
        <button v-for="t in tabs" :key="t.value" type="button"
          class="kit-tab" :class="{ 'kit-tab--active': modelValue === t.value }"
          @click="$emit('update:modelValue', t.value)">
          <span v-if="t.icon" class="material-symbols-outlined icon-sm">{{ t.icon }}</span>
          {{ t.label }}
        </button>
      </div>
    `,
  };

  /* ---------- Card ---------- */

  const KitCard = {
    name: 'KitCard',
    props: {
      title: String,
      icon: String,
      elevated: Boolean,
    },
    template: `
      <div class="kit-card" :class="{ 'kit-card--elevated': elevated }">
        <div v-if="title || $slots.header" class="kit-card__header">
          <span class="kit-card__title">
            <span v-if="icon" class="material-symbols-outlined icon-sm">{{ icon }}</span>
            <slot name="title">{{ title }}</slot>
          </span>
          <slot name="header-actions"></slot>
        </div>
        <div class="kit-card__body"><slot></slot></div>
        <div v-if="$slots.footer" class="kit-card__footer"><slot name="footer"></slot></div>
      </div>
    `,
  };

  const KitEmpty = {
    name: 'KitEmpty',
    props: {
      icon: { type: String, default: 'inbox' },
      title: String,
      desc: String,
    },
    template: `
      <div class="kit-empty">
        <span class="material-symbols-outlined">{{ icon }}</span>
        <span v-if="title" class="kit-empty__title">{{ title }}</span>
        <span v-if="desc" class="kit-empty__desc">{{ desc }}</span>
        <slot></slot>
      </div>
    `,
  };

  const KitAlert = {
    name: 'KitAlert',
    props: {
      type: { type: String, default: 'info' }, // info | success | warning | error
      icon: String,
    },
    computed: {
      iconName() {
        return this.icon || ({ info: 'info', success: 'check_circle', error: 'error', warning: 'warning' })[this.type] || 'info';
      },
    },
    template: `
      <div class="kit-alert" :class="'kit-alert--' + type">
        <span class="kit-alert__icon material-symbols-outlined">{{ iconName }}</span>
        <div class="flex-1"><slot></slot></div>
      </div>
    `,
  };

  const KitSkeleton = {
    name: 'KitSkeleton',
    props: {
      width: String,
      height: { type: String, default: '14px' },
      rounded: { type: String, default: '4px' },
    },
    template: `<span class="kit-skeleton inline-block" :style="{ width, height, borderRadius: rounded }"></span>`,
  };

  const KitProgress = {
    name: 'KitProgress',
    props: {
      value: { type: Number, default: 0 }, // 0-100
      status: { type: String, default: '' }, // '' | ok | error
    },
    template: `
      <div class="kit-progress" :class="{ 'kit-progress--ok': status === 'ok', 'kit-progress--error': status === 'error' }">
        <div class="kit-progress__bar" :style="{ width: Math.min(100, Math.max(0, value)) + '%' }"></div>
      </div>
    `,
  };

  /* ---------- Notify 服务 (程序化调用) ---------- */

  let toastHost = null;

  function ensureToastHost(app) {
    if (toastHost) return;
    const host = { render: () => null };
    // 通过一个隐藏组件挂载 host
    const hostDiv = document.createElement('div');
    hostDiv.id = 'kit-toast-host';
    document.body.appendChild(hostDiv);
    const HostApp = global.Vue.createApp({
      template: '<kit-toast-host ref="host"></kit-toast-host>',
    });
    HostApp.component('KitToastHost', KitToastHost);
    const vm = HostApp.mount(hostDiv);
    toastHost = vm.$refs.host;
  }

  const notify = {
    install(app) {
      app.config.globalProperties.$notify = notify;
      app.config.globalProperties.$toast = notify;
      app.config.globalProperties.$confirm = function (options) {
        return notify.confirm(options);
      };
      app.config.globalProperties.$dialog = function (options) {
        return notify.dialog(options);
      };
    },
    show(options) {
      ensureToastHost();
      if (typeof options === 'string') options = { message: options };
      return toastHost.add(options);
    },
    info(message, duration) { return notify.show({ type: 'info', message, duration }); },
    success(message, duration) { return notify.show({ type: 'success', message, duration }); },
    error(message, duration) { return notify.show({ type: 'error', message, duration }); },
    warning(message, duration) { return notify.show({ type: 'warning', message, duration }); },

    /* ---- 程序化 Confirm / Dialog ---- */
    confirm(options) {
      if (typeof options === 'string') options = { message: options };
      const opts = Object.assign({
        title: '确认操作',
        type: 'warning',
        confirmText: '确认',
        cancelText: '取消',
      }, options);
      return new Promise((resolve) => {
        const div = document.createElement('div');
        document.body.appendChild(div);
        const vm = global.Vue.createApp({
          data() { return { visible: true }; },
          methods: {
            onConfirm() { cleanup(true); },
            onCancel() { cleanup(false); },
          },
          template: `
            <kit-confirm v-model="visible" :title="opts.title" :message="opts.message"
              :type="opts.type" :confirm-text="opts.confirmText" :cancel-text="opts.cancelText"
              @confirm="onConfirm" @cancel="onCancel"></kit-confirm>
          `,
          computed: { opts: () => opts },
        });
        vm.component('KitConfirm', KitConfirm);
        vm.component('KitButton', KitButton);
        vm.component('KitIconButton', KitIconButton);
        vm.mount(div);
        function cleanup(result) {
          vm.unmount();
          div.remove();
          resolve(result);
        }
      });
    },
    dialog(options) {
      if (typeof options === 'string') options = { content: options };
      const opts = Object.assign({ title: '', size: 'md', showClose: true }, options);
      return new Promise((resolve) => {
        const div = document.createElement('div');
        document.body.appendChild(div);
        const vm = global.Vue.createApp({
          data() { return { visible: true }; },
          methods: {
            close() { cleanup(); },
          },
          template: `
            <kit-dialog v-model="visible" :title="opts.title" :icon="opts.icon" :size="opts.size"
              :show-close="opts.showClose" @close="close">
              <div v-html="opts.content"></div>
            </kit-dialog>
          `,
          computed: { opts: () => opts },
        });
        vm.component('KitDialog', KitDialog);
        vm.component('KitButton', KitButton);
        vm.component('KitIconButton', KitIconButton);
        vm.mount(div);
        function cleanup() {
          vm.unmount();
          div.remove();
          resolve();
        }
      });
    },
  };

  /* ---------- 插件入口 ---------- */

  const UIKit = {
    install(app) {
      const components = {
        KitButton, KitIconButton, KitInput, KitTextarea, KitSelect,
        KitCheckbox, KitRadio, KitSwitch, KitSlider,
        KitChip, KitBadge, KitStatusDot, KitField, KitSegmented, KitTagInput,
        KitDialog, KitConfirm, KitToastHost, KitTooltip, KitDropdown, KitTabs,
        KitCard, KitEmpty, KitAlert, KitSkeleton, KitProgress,
      };
      for (const [name, comp] of Object.entries(components)) {
        app.component(name, comp);
      }
      app.component('KitOption', KitOption);
      app.directive('tooltip', vTooltip);
      notify.install(app);
    },
  };

  global.UIKit = UIKit;
  global.KitNotify = notify;

})(typeof window !== 'undefined' ? window : this);
